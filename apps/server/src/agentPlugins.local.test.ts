import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const pluginRoot = path.join(repoRoot, "plugins", "jev-browser");

test("plugins/jev-browser ships a valid Agent Plugins 1.0.0 package", () => {
  assert.ok(fs.existsSync(path.join(pluginRoot, "plugin.json")), "plugin.json missing");
  assert.ok(fs.existsSync(path.join(pluginRoot, "skills", "jev-browser", "SKILL.md")), "SKILL.md missing");
  assert.ok(fs.existsSync(path.join(pluginRoot, "skills", "jev-browser", "scripts", "jev.py")), "jev.py missing");
  const manifest = JSON.parse(fs.readFileSync(path.join(pluginRoot, "plugin.json"), "utf8")) as {
    $schema?: string;
    name?: string;
  };
  assert.equal(manifest.$schema, "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json");
  assert.equal(manifest.name, "jev-browser");
});

test("local marketplace discovers jev-browser as not installed by default", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cca-plugins-test-"));
  process.env.CCA_DATA_DIR = dataDir;
  process.env.CCA_LOCAL_PLUGINS_DIR = path.join(repoRoot, "plugins");
  // Dynamic import after env so env.ts picks up the temp data dir.
  const { discoverLocalCatalogPlugins, listPluginMarketplaces, loadPlugin } = await import("./agentPlugins.js");
  const markets = listPluginMarketplaces();
  const local = markets.find((entry) => entry.id === "local");
  assert.ok(local, "local marketplace missing");
  assert.equal(local.kind, "local");
  assert.ok(local.pluginCount >= 1);

  const catalog = discoverLocalCatalogPlugins();
  const jev = catalog.find((entry) => entry.name === "jev-browser");
  assert.ok(jev, "jev-browser not discovered");
  assert.equal(jev.source, "local:jev-browser");
  assert.equal(jev.installed, false);
  assert.equal(jev.marketplaceId, "local");

  const discovery = loadPlugin(pluginRoot);
  assert.equal(discovery.manifest.name, "jev-browser");
  assert.equal(discovery.manifest.conformance, "agent-plugins-1.0.0");
  const skill = discovery.skills.find((entry) => entry.name === "jev-browser");
  assert.ok(skill?.valid, "jev-browser skill invalid");
});
