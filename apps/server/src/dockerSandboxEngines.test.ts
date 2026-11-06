import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import test from "node:test";

test("Codex and DSH discover Docker run_code and execute it through their real runtimes", {
  skip: !process.env.CCA_SANDBOX_INTEGRATION_CONFIG, timeout: 180000,
}, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cca-sandbox-engines-"));
  const previousConfig = process.env.CCA_DOCKER_SANDBOX_CONFIG;
  process.env.CCA_DATA_DIR = path.join(root, "data");
  process.env.CCA_DOCKER_SANDBOX_CONFIG = process.env.CCA_SANDBOX_INTEGRATION_CONFIG;
  const { CodexClient } = await import("./codex.js");
  const { DshClient } = await import("./dsh/dshClient.js");
  const requests: any[] = [];
  let executed = false;
  let round = 0;
  const upstream = createServer((req, res) => {
    void (async () => {
      let body = "";
      for await (const chunk of req) body += chunk;
      const request = JSON.parse(body);
      requests.push(request);
      if (requests.length > 10) throw new Error("Unexpected model loop");
      const history = request.messages ?? [];
      executed = history.some((m: any) => m.role === "tool" && m.tool_call_id === "call_docker_" + round && JSON.stringify(m.content).includes("changedFiles"));
      const names = (request.tools ?? []).map((tool: any) => tool.function?.name);
      const name = names.find((name: string) => name.includes("cca_sandbox") && name.endsWith("run_code"));
      const forbidden = names.filter((name: string) => /^(exec_command|shell|shell_command|write_stdin|apply_patch|read_file|write_file|bash|pwsh)$/.test(name));
      assert.deepEqual(forbidden, [], "Host execution tools must not be exposed");
      let delta: object;
      if (executed) delta = { content: "沙箱执行完成" };
      else {
        assert.ok(name || names.includes("tool_search"), JSON.stringify(names));
        delta = { tool_calls: [{ index: 0, id: name ? "call_docker_" + round : "call_search_" + round, type: "function", function: {
          name: name ?? "tool_search",
          arguments: name ? JSON.stringify({ code: `for(let i=0;i<3;i++){ await tools.write_file('engine-'+i+'.txt', '${round}'); } print(await tools.exec('uname -s'));` }) : '{"query":"+cca_sandbox run_code","limit":1}',
        } }] };
      }
      res.setHeader("content-type", "text/event-stream");
      res.end("data: " + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: executed ? "stop" : "tool_calls" }] }) + "\n\ndata: [DONE]\n\n");
    })().catch(error => { console.error(error); res.destroy(error); });
  });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  assert.ok(address && typeof address !== "string");
  t.after(async () => {
    upstream.closeAllConnections();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
    if (previousConfig === undefined) delete process.env.CCA_DOCKER_SANDBOX_CONFIG; else process.env.CCA_DOCKER_SANDBOX_CONFIG = previousConfig;
    await fs.rm(root, { recursive: true, force: true });
  });
  for (const [name, client] of [["Codex", new CodexClient()], ["DSH", new DshClient()]] as const) {
    await t.test(name, { timeout: 80000 }, async () => {
      requests.length = 0;
      executed = false;
      round = 1;
      const cwd = path.join(root, name);
      await fs.mkdir(cwd);
      await client.start();
      const config = { workingDirectory: cwd, model: "step-5-preview", provider: { type: "openai" as const, baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "test-key", wireApi: "completions" as const } };
      let session = await client.createSession(config);
      try {
        const result = await session.sendAndWait("在一个代码块中循环创建三个文件", 60000);
        assert.equal(result?.data.content, "沙箱执行完成");
        assert.ok(executed);
        assert.equal(await fs.readFile(path.join(cwd, "engine-2.txt"), "utf8"), "1");
        const id = session.sessionId;
        await session.disconnect();
        round = 2;
        executed = false;
        session = await client.resumeSession(id, config);
        const resumed = await session.sendAndWait("再运行一次代码块", 60000);
        assert.equal(resumed?.data.content, "沙箱执行完成");
        assert.equal(await fs.readFile(path.join(cwd, "engine-2.txt"), "utf8"), "2");
      } finally { await session.disconnect(); await client.stop(); }
    });
  }
});
