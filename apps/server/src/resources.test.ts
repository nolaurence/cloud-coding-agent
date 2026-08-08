import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { AppSettings } from "@cca/protocol";
import { createAgentResourceTools } from "./agentResources.js";
import {
  effectiveMcpServers,
  listWorkspaceMcpServers,
  saveScopedMcpServer,
} from "./mcpServers.js";
import {
  deleteScopedSkill,
  listScopedSkills,
  saveScopedSkill,
} from "./skills.js";
import { store } from "./store.js";

function fixture(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cca-resources-"));
  const previousSettings = store.settings;
  store.settings = {
    providers: [],
    connectors: [],
    mcpServers: [],
    skillDirectories: [],
    disabledSkills: [],
  } satisfies AppSettings;
  t.after(() => {
    store.settings = previousSettings;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

test("creates, updates, lists, and deletes workspace skills", (t) => {
  const root = fixture(t);
  const created = saveScopedSkill("workspace", "code-review", "Review code", "# Steps\n", root, "create");
  assert.equal(created.scope, "workspace");
  assert.equal(created.description, "Review code");
  assert.match(created.content, /name: code-review/);
  assert.equal(listScopedSkills("workspace", root).length, 1);

  const updated = saveScopedSkill("workspace", "code-review", "Updated", "# New steps\n", root, "update");
  assert.equal(updated.description, "Updated");
  assert.match(updated.content, /# New steps/);
  assert.throws(() => saveScopedSkill("workspace", "../escape", "", "bad", root), /技能名称/);

  deleteScopedSkill("workspace", "code-review", root);
  assert.deepEqual(listScopedSkills("workspace", root), []);
});

test("rejects workspace skill directories linked outside the workspace", (t) => {
  const root = fixture(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "cca-resources-outside-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, ".github"));
  fs.symlinkSync(outside, path.join(root, ".github", "skills"), "junction");

  assert.throws(
    () => saveScopedSkill("workspace", "unsafe", "", "# Unsafe", root),
    /符号链接/,
  );
});

test("rejects workspace SKILL.md files linked outside the skill directory", (t) => {
  const root = fixture(t);
  const skillDir = path.join(root, ".github", "skills", "linked");
  fs.mkdirSync(skillDir, { recursive: true });
  const outside = path.join(root, "outside-skill.md");
  fs.writeFileSync(outside, "# Outside");
  fs.symlinkSync(outside, path.join(skillDir, "SKILL.md"));

  assert.throws(() => listScopedSkills("workspace", root), /符号链接/);
});

test("persists standard workspace MCP configuration and merges it over platform config", (t) => {
  const root = fixture(t);
  store.settings = {
    ...store.settings,
    mcpServers: [{
      id: "shared",
      name: "Platform",
      enabled: true,
      type: "http",
      url: "https://platform.example/mcp",
      tools: ["read"],
    }],
  };

  saveScopedMcpServer("workspace", {
    id: "shared",
    name: "Workspace",
    enabled: true,
    type: "local",
    command: "node",
    args: ["server.js"],
    cwd: "tools",
    tools: ["*"],
  }, root, "create");
  const document = JSON.parse(fs.readFileSync(path.join(root, ".mcp.json"), "utf8")) as {
    mcpServers: Record<string, { type: string }>;
  };
  assert.equal(document.mcpServers.shared?.type, "stdio");
  assert.equal(listWorkspaceMcpServers(root)[0]?.name, "Workspace");

  const effective = effectiveMcpServers(root);
  assert.deepEqual(effective.shared, {
    type: "stdio",
    command: "node",
    args: ["server.js"],
    env: {},
    workingDirectory: path.join(root, "tools"),
    tools: ["*"],
    timeout: undefined,
  });
});


test("preserves MCP secrets when an agent submits redacted placeholders", (t) => {
  const root = fixture(t);
  saveScopedMcpServer("workspace", {
    id: "secret",
    name: "Secret",
    enabled: true,
    type: "http",
    url: "https://example.com/mcp",
    headers: { Authorization: "Bearer original" },
    tools: ["*"],
  }, root, "create");

  const updated = saveScopedMcpServer("workspace", {
    id: "secret",
    name: "Updated",
    headers: { Authorization: "******" },
  }, root, "update");
  assert.deepEqual(updated.headers, { Authorization: "Bearer original" });
});

test("rejects MCP paths outside the workspace and linked configuration files", (t) => {
  const root = fixture(t);
  saveScopedMcpServer("workspace", {
    id: "unsafe",
    name: "Unsafe",
    enabled: true,
    type: "local",
    command: "node",
    cwd: "..",
    tools: ["*"],
  }, root, "create");
  assert.throws(() => effectiveMcpServers(root), /不能超出当前工作区/);

  fs.rmSync(path.join(root, ".mcp.json"));
  const outside = path.join(os.tmpdir(), `cca-mcp-outside-${Date.now()}.json`);
  fs.writeFileSync(outside, JSON.stringify({ mcpServers: {} }));
  t.after(() => fs.rmSync(outside, { force: true }));
  fs.symlinkSync(outside, path.join(root, ".mcp.json"));
  assert.throws(() => listWorkspaceMcpServers(root), /符号链接/);
});

test("agent tools allow workspace CRUD but deny platform writes for non-admins", async (t) => {
  const root = fixture(t);
  const changed: string[] = [];
  const [skillTool, mcpTool] = createAgentResourceTools({
    workspacePath: root,
    canManagePlatform: () => false,
    onChanged: (scope) => { changed.push(scope); },
  });
  assert.ok(skillTool.handler);
  assert.ok(mcpTool.handler);

  await assert.rejects(
    async () => skillTool.handler!({ action: "create", scope: "platform", name: "blocked", content: "# No" }, {} as never),
    /只有管理员 Agent/,
  );
  await skillTool.handler!({
    action: "create",
    scope: "workspace",
    name: "allowed",
    description: "Allowed",
    content: "# Yes",
  }, {} as never);
  const listed = await skillTool.handler!({ action: "list", scope: "workspace" }, {} as never);
  assert.match(String(listed), /allowed/);
  assert.deepEqual(changed, ["workspace"]);
});
