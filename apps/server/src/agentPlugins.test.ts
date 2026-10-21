import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import {
  collectPluginMcpServers,
  collectPluginSkillDirs,
  parseSkillMarkdown,
  pluginDataDir,
  pluginEnv,
  scanAgentPlugins,
} from "./agentPlugins.js";
import type { AgentPluginMcpServer, AgentPluginSkill } from "@cca/protocol";

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cca-agent-plugins-"));
  const pluginRoot = path.join(root, "plugins");
  const dataRoot = path.join(root, "data");
  fs.mkdirSync(pluginRoot);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, pluginRoot, dataRoot };
}

function writePlugin(
  pluginRoot: string,
  dirName: string,
  manifest: string | object,
  setup?: (pluginDir: string) => void,
): string {
  const pluginDir = path.join(pluginRoot, dirName);
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, "plugin.json"),
    typeof manifest === "string" ? manifest : JSON.stringify(manifest, null, 2),
    "utf8",
  );
  setup?.(pluginDir);
  return pluginDir;
}

function writeSkill(pluginDir: string, skillId: string, markdown: string): void {
  const skillDir = path.join(pluginDir, "skills", skillId);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), markdown, "utf8");
}

test("loads a minimal plugin and creates its data directory", (t) => {
  const { pluginRoot, dataRoot } = fixture(t);
  const pluginDir = writePlugin(pluginRoot, "research-tools", { name: "research-tools" });

  const result = scanAgentPlugins(pluginRoot, dataRoot);

  assert.equal(result.pluginRoot, pluginRoot);
  assert.equal(result.dataRoot, dataRoot);
  assert.equal(result.plugins.length, 1);
  const record = result.plugins[0]!;
  assert.equal(record.id, "research-tools");
  assert.equal(record.path, pluginDir);
  assert.equal(record.manifest.name, "research-tools");
  assert.equal(record.valid, true);
  assert.deepEqual(record.errors, []);
  assert.deepEqual(record.skills, []);
  assert.deepEqual(record.mcpServers, []);
  assert.equal(record.hasExtensions, false);
  assert.ok(record.warnings.some((warning) => warning.includes("missing $schema")));

  assert.equal(pluginDataDir(dataRoot, "research-tools"), path.join(dataRoot, "research-tools"));
  assert.deepEqual(pluginEnv(record, dataRoot), {
    PLUGIN_ROOT: pluginDir,
    PLUGIN_DATA: path.join(dataRoot, "research-tools"),
  });
  assert.equal(fs.statSync(path.join(dataRoot, "research-tools")).isDirectory(), true);
});

test("loads skills, mcp servers and extensions from a complete plugin", (t) => {
  const { pluginRoot, dataRoot } = fixture(t);
  const pluginDir = writePlugin(
    pluginRoot,
    "full-tools",
    {
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: "full-tools",
      version: "1.2.3",
      description: "完整插件",
      author: { name: "Alice", url: "https://example.com" },
      license: "MIT",
      keywords: ["research", "tools"],
      homepage: "https://example.com/full-tools",
    },
    (dir) => {
      writeSkill(dir, "greet", "---\nname: greet\ndescription: 生成问候语\n---\n\n# Greet\n\n说你好。\n");
      writeSkill(
        dir,
        "summarize",
        "---\r\nname: summarize\r\ndescription: \"总结文本\"\r\n---\r\n\r\n总结内容。\r\n",
      );
      fs.writeFileSync(
        path.join(dir, "mcp.json"),
        JSON.stringify({
          servers: {
            local: { command: "node", args: ["server.js"], env: { KEY: "value" }, cwd: "." },
            remote: {
              url: "https://example.com/mcp",
              headers: { Authorization: "Bearer x" },
            },
          },
        }),
        "utf8",
      );
      fs.mkdirSync(path.join(dir, "extensions"));
      fs.writeFileSync(path.join(dir, "extensions", "vscode.json"), "{}", "utf8");
    },
  );

  const result = scanAgentPlugins(pluginRoot, dataRoot);
  assert.equal(result.plugins.length, 1);
  const record = result.plugins[0]!;
  assert.equal(record.valid, true);
  assert.deepEqual(record.errors, []);
  assert.deepEqual(record.warnings, []);
  assert.equal(record.hasExtensions, true);
  assert.equal(record.manifest.version, "1.2.3");
  assert.deepEqual(record.manifest.author, { name: "Alice", url: "https://example.com" });

  assert.deepEqual(
    record.skills.map((skill) => [skill.id, skill.name, skill.description, skill.valid]),
    [
      ["greet", "greet", "生成问候语", true],
      ["summarize", "summarize", "总结文本", true],
    ],
  );
  assert.equal(record.skills[0]!.path, path.join(pluginDir, "skills", "greet", "SKILL.md"));

  assert.deepEqual(
    record.mcpServers.map((server) => [server.name, server.transport, server.valid]),
    [
      ["local", "stdio", true],
      ["remote", "streamable-http", true],
    ],
  );
  assert.equal(record.mcpServers[0]!.command, "node");
  assert.deepEqual(record.mcpServers[0]!.env, { KEY: "value" });
  assert.equal(record.mcpServers[1]!.url, "https://example.com/mcp");
  assert.deepEqual(record.mcpServers[1]!.headers, { Authorization: "Bearer x" });

  assert.deepEqual(collectPluginSkillDirs(result), [path.join(pluginDir, "skills")]);
  assert.deepEqual(
    collectPluginMcpServers(result).map((server) => server.name),
    ["local", "remote"],
  );
});

test("isolates a plugin with a broken plugin.json from the others", (t) => {
  const { pluginRoot, dataRoot } = fixture(t);
  writePlugin(pluginRoot, "broken", "{ not valid json");
  writePlugin(pluginRoot, "good", { name: "good" });

  const result = scanAgentPlugins(pluginRoot, dataRoot);
  assert.equal(result.plugins.length, 2);
  const broken = result.plugins.find((record) => record.path === path.join(pluginRoot, "broken"))!;
  const good = result.plugins.find((record) => record.path === path.join(pluginRoot, "good"))!;
  assert.equal(broken.valid, false);
  assert.ok(broken.errors.some((error) => error.includes("invalid plugin.json")));
  assert.equal(good.valid, true);
});

test("reports directories without plugin.json and skips hidden or root level entries", (t) => {
  const { pluginRoot, dataRoot } = fixture(t);
  fs.writeFileSync(path.join(pluginRoot, "plugin.json"), JSON.stringify({ name: "root" }), "utf8");
  fs.mkdirSync(path.join(pluginRoot, "empty-dir"));
  writePlugin(pluginRoot, ".hidden", { name: "hidden" });
  writePlugin(pluginRoot, "visible", { name: "visible" });

  const result = scanAgentPlugins(pluginRoot, dataRoot);
  assert.deepEqual(
    result.plugins.map((record) => [record.path, record.valid]),
    [
      [path.join(pluginRoot, "empty-dir"), false],
      [path.join(pluginRoot, "visible"), true],
    ],
  );
  assert.ok(result.plugins[0]!.errors.includes("missing plugin.json"));
});

test("rejects plugin names that violate the Agent Plugins naming rules", (t) => {
  const { pluginRoot, dataRoot } = fixture(t);
  writePlugin(pluginRoot, "spaces", { name: "Bad Name" });
  writePlugin(pluginRoot, "upper", { name: "UPPER" });
  writePlugin(pluginRoot, "toolong", { name: "a".repeat(65) });
  writePlugin(pluginRoot, "nameless", {});

  const result = scanAgentPlugins(pluginRoot, dataRoot);
  assert.equal(result.plugins.length, 4);
  for (const record of result.plugins) {
    assert.equal(record.valid, false);
  }
  assert.ok(
    result.plugins
      .filter((record) => record.id !== "nameless")
      .every((record) => record.errors.some((error) => error.includes("invalid plugin name"))),
  );
  assert.ok(
    result.plugins
      .find((record) => record.id === "nameless")!
      .errors.includes("missing plugin name"),
  );
  // Invalid names never claim a data directory.
  assert.deepEqual(fs.existsSync(path.join(dataRoot, "Bad Name")), false);
});

test("keeps the first scanned plugin when plugin names are duplicated", (t) => {
  const { pluginRoot, dataRoot } = fixture(t);
  writePlugin(pluginRoot, "a-first", { name: "same-name" });
  writePlugin(pluginRoot, "b-second", { name: "same-name" });

  const result = scanAgentPlugins(pluginRoot, dataRoot);
  const [first, second] = result.plugins;
  assert.equal(first!.path, path.join(pluginRoot, "a-first"));
  assert.equal(first!.valid, true);
  assert.equal(second!.path, path.join(pluginRoot, "b-second"));
  assert.equal(second!.valid, false);
  assert.ok(second!.errors.includes("duplicate plugin name"));
});

test("keeps valid skills when sibling skills are invalid", (t) => {
  const { pluginRoot, dataRoot } = fixture(t);
  const pluginDir = writePlugin(pluginRoot, "skill-tools", { name: "skill-tools" }, (dir) => {
    writeSkill(dir, "good", "---\nname: good\ndescription: 正常技能\n---\n\n按步骤执行。\n");
    writeSkill(dir, "no-desc", "---\nname: no-desc\n---\n\n有正文但没有描述。\n");
    writeSkill(dir, "empty-body", "---\nname: empty-body\ndescription: 空正文\n---\n\n   \n");
    writeSkill(dir, "Bad_Skill", "---\nname: bad\ndescription: 目录名非法\n---\n\n正文。\n");
  });

  const result = scanAgentPlugins(pluginRoot, dataRoot);
  const record = result.plugins[0]!;
  // Skill failures stay inside their own skill entry.
  assert.equal(record.valid, true);
  assert.equal(record.skills.length, 4);
  const byId = new Map<string, AgentPluginSkill>(
    record.skills.map((skill) => [skill.id, skill]),
  );
  assert.equal(byId.get("good")!.valid, true);
  assert.equal(byId.get("good")!.name, "good");
  assert.equal(byId.get("no-desc")!.valid, false);
  assert.match(byId.get("no-desc")!.error ?? "", /description/);
  assert.equal(byId.get("empty-body")!.valid, false);
  assert.equal(byId.get("empty-body")!.error, "empty skill body");
  assert.equal(byId.get("Bad_Skill")!.valid, false);
  assert.match(byId.get("Bad_Skill")!.error ?? "", /invalid skill id/);
  assert.deepEqual(collectPluginSkillDirs(result), [path.join(pluginDir, "skills")]);
});

test("skips invalid mcp server entries without dropping valid ones", (t) => {
  const { pluginRoot, dataRoot } = fixture(t);
  writePlugin(pluginRoot, "mcp-tools", { name: "mcp-tools" }, (dir) => {
    fs.writeFileSync(
      path.join(dir, "mcp.json"),
      JSON.stringify({
        servers: {
          both: { command: "node", args: ["server.js"], url: "https://example.com/mcp" },
          neither: {},
          local: { command: "node", args: ["server.js"], env: { KEY: "value" } },
          "Bad Name": { command: "node" },
          badenv: { command: "node", env: { KEY: 42 } },
        },
      }),
      "utf8",
    );
  });

  const result = scanAgentPlugins(pluginRoot, dataRoot);
  const record = result.plugins[0]!;
  // Per-entry failures do not invalidate the plugin.
  assert.equal(record.valid, true);
  assert.deepEqual(record.errors, []);
  const byName = new Map<string, AgentPluginMcpServer>(
    record.mcpServers.map((server) => [server.name, server]),
  );
  assert.equal(byName.get("both")!.valid, false);
  assert.match(byName.get("both")!.error ?? "", /mutually exclusive/);
  assert.equal(byName.get("neither")!.valid, false);
  assert.equal(byName.get("local")!.valid, true);
  assert.equal(byName.get("local")!.transport, "stdio");
  assert.equal(byName.get("Bad Name")!.valid, false);
  assert.match(byName.get("Bad Name")!.error ?? "", /invalid server name/);
  assert.equal(byName.get("badenv")!.valid, false);
  assert.match(byName.get("badenv")!.error ?? "", /env values must be strings/);
  assert.deepEqual(
    collectPluginMcpServers(result).map((server) => server.name),
    ["local"],
  );
});

test("warns about missing $schema and unknown manifest fields but stays valid", (t) => {
  const { pluginRoot, dataRoot } = fixture(t);
  writePlugin(pluginRoot, "warned", {
    name: "warned",
    customField: 1,
    another: "x",
    vendor: { nested: true },
  });

  const result = scanAgentPlugins(pluginRoot, dataRoot);
  const record = result.plugins[0]!;
  assert.equal(record.valid, true);
  assert.deepEqual(record.errors, []);
  assert.ok(record.warnings.some((warning) => warning.includes("missing $schema")));
  assert.ok(
    record.warnings.some(
      (warning) =>
        warning.includes("unknown manifest fields") &&
        warning.includes("another") &&
        warning.includes("customField") &&
        warning.includes("vendor"),
    ),
  );
  // Unknown fields are preserved for forward compatibility.
  assert.equal(record.manifest.customField, 1);
});

test("returns an empty result when the plugin root cannot be read", (t) => {
  const { root, dataRoot } = fixture(t);
  const missingRoot = path.join(root, "missing");
  const result = scanAgentPlugins(missingRoot, dataRoot);
  assert.deepEqual(result.plugins, []);
  assert.equal(result.pluginRoot, missingRoot);
});

test("parseSkillMarkdown reads simple frontmatter and rejects broken skills", () => {
  const parsed = parseSkillMarkdown("---\nname: greet\ndescription: 生成问候语\n---\n\n# Greet\n\n说你好。\n");
  assert.equal(parsed.name, "greet");
  assert.equal(parsed.description, "生成问候语");
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.body.trim(), "# Greet\n\n说你好。");

  const quoted = parseSkillMarkdown(
    "---\r\nname: \"summarize\"\r\ndescription: '总结文本'\r\n---\r\n\r\n总结内容。",
  );
  assert.equal(quoted.name, "summarize");
  assert.equal(quoted.description, "总结文本");
  assert.equal(quoted.error, undefined);

  assert.equal(
    parseSkillMarkdown("---\nname: x\ndescription: y\n---\n\n   \n").error,
    "empty skill body",
  );
  assert.match(parseSkillMarkdown("---\nname: x\n---\n\n正文\n").error ?? "", /description/);
  assert.match(parseSkillMarkdown("没有 frontmatter 的正文\n").error ?? "", /name/);
  assert.match(
    parseSkillMarkdown("---\nname: x\ndescription: y\n\n正文但没有闭合\n").error ?? "",
    /frontmatter/,
  );
});
