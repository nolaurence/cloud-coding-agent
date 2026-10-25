import assert from "node:assert/strict";
import fs from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DeepSeekHarness } from "@deepseek-ai/dsh-sdk-client";
import type { ReasoningEffort } from "@cca/protocol";
import { sanitizedDshRuntimeEnv } from "../runtimeEnv.js";
import {
  credentialEnvName,
  dshBinPath,
  dshCliEntry,
  patchDocFor,
  piAiApiFor,
  piAiReasoningFor,
  prepareDshHome,
  sandboxModeFor,
  type DshProviderRoute,
} from "./dshConfig.js";

function tempDir(t: { after: (fn: () => void) => void }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cca-dsh-config-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("permission modes map to DSH sandbox modes without interactive approvals", () => {
  assert.equal(sandboxModeFor("full"), "danger-full-access");
  assert.equal(sandboxModeFor("request"), "workspace-write");
  assert.equal(sandboxModeFor("auto"), "workspace-write");
  assert.equal(sandboxModeFor(undefined), "workspace-write");
});

test("provider type and wire API map to pi-ai protocols", () => {
  assert.equal(piAiApiFor("openai", "completions"), "openai-completions");
  assert.equal(piAiApiFor("openai", "responses"), "openai-responses");
  assert.equal(piAiApiFor("openai", undefined), "openai-completions");
  assert.equal(piAiApiFor("anthropic", "completions"), "anthropic-messages");
  assert.equal(piAiReasoningFor("none"), "off");
  assert.equal(piAiReasoningFor("max"), "max");
  assert.equal(piAiReasoningFor(undefined), undefined);
});

test("patch keeps credentials out of the file and mounts sandbox, approvals, and MCP rows", () => {
  const route: DshProviderRoute = {
    id: "cca-primary",
    type: "openai",
    baseUrl: "https://example.test/v1",
    apiKey: "sk-secret",
    wireApi: "responses",
    reasoningEffort: "high",
    models: [{ id: "m1", name: "Model 1", contextWindow: 128_000 }],
  };
  const patch = JSON.stringify(
    patchDocFor(
      [route],
      [
        {
          id: "cca-mcp-demo",
          serverName: "demo",
          config: {
            transport: "stdio",
            serverName: "demo",
            command: "node",
            args: ["server.js"],
            env: {},
            cwd: "/workspace",
          },
          timeoutMs: 12_000,
        },
      ],
      "workspace-write",
      "/workspace",
    ),
  );
  assert.equal(patch.includes("sk-secret"), false);
  assert.equal(patch.includes(credentialEnvName("cca-primary")), true);
  assert.equal(patch.includes('"api":"openai-responses"'), true);
  assert.equal(patch.includes('"reasoning":"high"'), true);
  assert.equal(patch.includes('"contextWindow":128000'), true);
  assert.equal(patch.includes('"id":"sandbox-policy"'), true);
  assert.equal(patch.includes('"policy":"never"'), true);
  assert.equal(patch.includes('"defaultPreset":"workspace-write"'), true);
  assert.equal(patch.includes('"name":"@deepseek-ai/dsh-mcp-client"'), true);
  assert.equal(patch.includes('"toolCallTimeoutMs":12000'), true);
});

test("prepareDshHome creates the profile parent, links enabled skills, and hides disabled ones", (t) => {
  const root = tempDir(t);
  const skills = path.join(root, "skills");
  for (const name of ["review", "disabled-skill"]) {
    fs.mkdirSync(path.join(skills, name), { recursive: true });
    fs.writeFileSync(path.join(skills, name, "SKILL.md"), `# ${name}\n`);
  }
  const home = path.join(root, "dsh-home");
  fs.mkdirSync(path.join(home, "skills", "stale-skill"), { recursive: true });
  fs.writeFileSync(path.join(home, "skills", "stale-skill", "SKILL.md"), "# stale\n");
  fs.mkdirSync(path.join(home, "skills", ".system", "keep"), { recursive: true });
  fs.writeFileSync(path.join(home, "skills", ".system", "keep", "SKILL.md"), "# system\n");
  const { patchPath } = prepareDshHome(
    {
      homeDir: home,
      skillDirs: [skills],
      disabledSkills: ["disabled-skill"],
      mcpRows: [],
      sandboxMode: "danger-full-access",
      workspaceRoot: root,
    },
    [
      {
        id: "cca-primary",
        type: "openai",
        baseUrl: "https://example.test/v1",
        models: [{ id: "m1" }],
      },
    ],
  );
  assert.equal(fs.existsSync(path.join(home, "profiles")), true);
  assert.equal(fs.existsSync(path.join(home, "skills", "review", "SKILL.md")), true);
  assert.equal(fs.existsSync(path.join(home, "skills", "disabled-skill")), false);
  assert.equal(fs.existsSync(path.join(home, "skills", "stale-skill")), false);
  assert.equal(fs.existsSync(path.join(home, "skills", ".system", "keep", "SKILL.md")), true);
  const patch = JSON.parse(fs.readFileSync(patchPath, "utf8")) as Array<Record<string, unknown>>;
  assert.equal(patch.some((row) => row.id === "llm-pi-ai"), true);
  assert.equal(patch.some((row) => row.id === "sandbox-policy"), true);
  if (process.platform !== "win32") assert.equal(fs.statSync(patchPath).mode & 0o777, 0o600);
});

test("runtime command honours CCA_DSH_PATH and defaults to the installed CLI", (t) => {
  const previous = process.env.CCA_DSH_PATH;
  t.after(() => {
    if (previous === undefined) delete process.env.CCA_DSH_PATH;
    else process.env.CCA_DSH_PATH = previous;
  });
  process.env.CCA_DSH_PATH = "/opt/custom/dsh";
  assert.equal(dshBinPath(), "/opt/custom/dsh");
  delete process.env.CCA_DSH_PATH;
  assert.match(dshCliEntry(), /dsh[\\/]lib[\\/]bin\.js$/);
  assert.equal(dshBinPath(), dshCliEntry());
});

test("DSH custom routes deliver the selected reasoning effort to the provider", { timeout: 60_000 }, async (t) => {
  const requests: Record<string, unknown>[] = [];
  const upstream = createServer((req, res) => {
    void (async () => {
      let body = "";
      for await (const chunk of req) body += chunk;
      requests.push(JSON.parse(body));
      res.setHeader("content-type", "text/event-stream");
      res.end('data: {"choices":[{"index":0,"delta":{"content":"你好"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    })().catch((error) => res.destroy(error));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => {
    upstream.closeAllConnections();
    upstream.close(() => resolve());
  }));
  const address = upstream.address();
  assert.ok(address && typeof address !== "string");
  const efforts: Array<ReasoningEffort | undefined> = ["medium", "max", "none", undefined];
  for (const reasoningEffort of efforts) {
    await t.test(reasoningEffort ?? "provider default", async (t) => {
      const root = tempDir(t);
      const homeDir = path.join(root, "home");
      const { patchPath } = prepareDshHome({
        homeDir,
        skillDirs: [],
        disabledSkills: [],
        mcpRows: [],
        sandboxMode: "danger-full-access",
        workspaceRoot: root,
      }, [{
        id: "cca-primary",
        type: "openai",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        apiKey: "test-key",
        reasoningEffort,
        models: [{ id: "step-5-preview" }],
      }]);
      const harness = new DeepSeekHarness({
        dshBin: dshCliEntry(),
        dshHome: homeDir,
        patches: [patchPath],
        cwd: root,
        processCwd: root,
        provider: "cca-primary",
        model: "step-5-preview",
        env: sanitizedDshRuntimeEnv(homeDir, { [credentialEnvName("cca-primary")]: "test-key" }),
        initializeTimeoutMs: 15_000,
        requestTimeoutMs: 15_000,
      });
      t.after(() => harness.close());
      const previousCount = requests.length;
      const result = await harness.run("你好");
      assert.equal(result.finalResponse, "你好");
      assert.equal(requests.length, previousCount + 1);
      assert.equal(requests.at(-1)?.model, "step-5-preview");
      assert.equal(requests.at(-1)?.reasoning_effort, reasoningEffort === "none" ? undefined : reasoningEffort);
    });
  }
});
