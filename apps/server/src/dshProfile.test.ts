import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";
import { pathToFileURL } from "node:url";
import { DEFAULT_SETTINGS } from "@cca/protocol";
import type { ModelEntry, ModelProviderConfig } from "@cca/protocol";
import {
  assertDshTrajectoryBundle,
  DSH_TRAJECTORY_ENTRY_URL,
  buildDshIntegration,
  ensureDshProfile,
  ensureDshWorkspace,
  providerRouteName,
  writeDshSshConfig,
} from "./dshProfile.js";

const sandbox = {
  enabled: true,
  host: "192.0.2.10",
  user: "sandbox",
  identityFile: "/tmp/id",
  knownHostsFile: "/tmp/known_hosts",
  helper: "/opt/helper.js",
  helperHash: "a".repeat(64),
  workspace: "/workspace",
  tmpdir: "/tmp/dsh-ssh",
};

const provider: ModelProviderConfig = {
  id: "team-gateway",
  name: "团队网关",
  type: "openai",
  baseUrl: "https://example.test/v1",
  models: [{ id: "coding-model", name: "Coding", contextWindowTokens: 200_000 }],
};

const route = {
  provider,
  providerName: providerRouteName(provider.id, 0),
  apiKeyEnv: "CCA_DSH_GATEWAY_KEY_0",
  url: "http://127.0.0.1:1234",
};

test("DSH integration uses the configured default model and sandbox providers", () => {
  const integration = buildDshIntegration(
    {
      ...DEFAULT_SETTINGS,
      providers: [provider],
      defaultModel: { providerId: provider.id, modelId: "coding-model" },
    },
    [route],
    sandbox,
  );

  assert.deepEqual(integration.defaultModel, {
    provider: route.providerName,
    model: "coding-model",
  });
  const serialized = JSON.stringify(integration.patch);
  assert.match(serialized, /dsh-ssh/);
  assert.match(serialized, /dsh-fs-ssh/);
  assert.match(serialized, /openai-responses/);
  assert.match(serialized, /danger-full-access/);
  assert.match(serialized, /"defaultPreset":"danger-full-access"/);
  assert.match(serialized, /"id":"open-in-app","disabled":true/);
  assert.match(serialized, /"id":"ui-settings","disabled":false,"config":\{"enabled":true\}/);
  assert.match(serialized, /"id":"ui-trajectory","disabled":true/);
});

test("DSH integration falls back to the first usable provider", () => {
  const integration = buildDshIntegration(
    { ...DEFAULT_SETTINGS, providers: [provider] },
    [route],
    { ...sandbox, enabled: false },
  );
  assert.deepEqual(integration.defaultModel, {
    provider: route.providerName,
    model: "coding-model",
  });
  assert.doesNotMatch(JSON.stringify(integration.patch), /dsh-ssh/);
});

for (const sandboxEnabled of [true, false]) {
  test(`DSH loads CCA's source bundle with sandbox ${sandboxEnabled ? "enabled" : "disabled"}`, () => {
    const integration = buildDshIntegration(
      { ...DEFAULT_SETTINGS, providers: [provider] },
      [route],
      { ...sandbox, enabled: sandboxEnabled },
    );
    assert.ok(integration.patch.some((patch) =>
      isDeepStrictEqual(patch, { id: "ui-trajectory", disabled: true }),
    ));
    assert.ok(integration.patch.some((patch) =>
      isDeepStrictEqual(patch, { insert: [{ id: "cca-ui-trajectory", name: DSH_TRAJECTORY_ENTRY_URL }] }),
    ));
    assert.equal(DSH_TRAJECTORY_ENTRY_URL, new URL("../dist/dsh-ui-trajectory/index.js", import.meta.url).href);
  });
}

test("DSH refuses an incomplete CCA trajectory bundle instead of falling back to npm", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cca-dsh-trajectory-"));
  const directory = path.join(root, "plugin with spaces");
  fs.mkdirSync(directory);
  const entryUrl = pathToFileURL(path.join(directory, "index.js")).href;
  try {
    assert.throws(() => assertDshTrajectoryBundle(entryUrl), /npm run build:dsh/);
    fs.writeFileSync(path.join(directory, "index.js"), "export function apply() {}\n");
    fs.writeFileSync(path.join(directory, "package.json"), "{}\n");
    assert.throws(() => assertDshTrajectoryBundle(entryUrl), /缺少 client\.js/);
    fs.writeFileSync(path.join(directory, "client.js"), "// browser bundle\n");
    assert.doesNotThrow(() => assertDshTrajectoryBundle(entryUrl));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("DSH integration maps CCA reasoning efforts without inventing capabilities", () => {
  const model: ModelEntry = {
    id: "reasoning-model",
    supportedReasoningEfforts: ["none", "low", "high"],
  };
  const reasoningProvider: ModelProviderConfig = { ...provider, models: [model] };
  const integration = buildDshIntegration(
    { ...DEFAULT_SETTINGS, providers: [reasoningProvider] },
    [{ ...route, provider: reasoningProvider }],
    sandbox,
  );
  const serialized = JSON.stringify(integration.patch);
  assert.match(serialized, /"off":null/);
  assert.match(serialized, /"high":"high"/);
});

test("DSH integration refuses an empty provider catalogue", () => {
  assert.throws(
    () => buildDshIntegration({ ...DEFAULT_SETTINGS, providers: [] }, [], sandbox),
    /没有可用于 DSH/,
  );
});

test("DSH workspace storage is seeded once with the sandbox path", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cca-dsh-workspace-"));
  try {
    const workspace = path.join(root, "workspace");
    fs.mkdirSync(workspace);
    ensureDshWorkspace(root, workspace);
    const file = path.join(root, "storages", "workspace.json");
    const state = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(state.global.defaultWorkspaceId, "cca-default");
    assert.deepEqual(state.global.workspaceIds, ["cca-default"]);
    assert.equal(state.tables.workspaces["cca-default"].path, fs.realpathSync(workspace));

    state.tables.workspaces["cca-default"].title = "保留标题";
    fs.writeFileSync(file, JSON.stringify(state));
    ensureDshWorkspace(root, workspace);
    assert.equal(
      JSON.parse(fs.readFileSync(file, "utf8")).tables.workspaces["cca-default"].title,
      "保留标题",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("DSH workspace registry maps projects to sandbox workspaces and keeps sessions", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cca-dsh-projects-"));
  try {
    const workspace = path.join(root, "workspace");
    const good = path.join(workspace, "good-id");
    const qq = path.join(workspace, "qq-id");
    fs.mkdirSync(good, { recursive: true });
    fs.mkdirSync(qq, { recursive: true });
    const file = path.join(root, "storages", "workspace.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const createdAt = "2026-01-01T00:00:00.000Z";
    fs.writeFileSync(file, JSON.stringify({
      unit: { name: "workspace", version: 2 },
      global: {
        initialized: true,
        defaultWorkspaceId: "cca-default",
        workspaceIds: ["legacy-project", "cca-default"],
        archivedSessionIds: ["session-archived"],
        pinnedSessionIds: [],
      },
      tables: {
        workspaces: {
          "legacy-project": {
            path: fs.realpathSync(good),
            title: "good-id",
            sessionIds: ["session-good"],
            createdAt,
            updatedAt: createdAt,
          },
          "cca-default": {
            path: fs.realpathSync(workspace),
            title: "工作区",
            sessionIds: ["session-old"],
            createdAt,
            updatedAt: createdAt,
          },
        },
      },
    }));

    ensureDshWorkspace(root, workspace, [
      { id: "good-id", name: "good", path: good },
      { id: "qq-id", name: "qqbot", path: qq },
      { id: "outside", name: "cloud-coding-agent", path: path.join(root, "cloud-coding-agent") },
    ]);

    const state = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(state.global.initialized, true);
    assert.deepEqual(state.global.workspaceIds, [
      "legacy-project",
      "cca-project-qq-id",
      "cca-default",
    ]);
    assert.equal(state.global.defaultWorkspaceId, "legacy-project");
    assert.equal(state.tables.workspaces["legacy-project"].title, "good");
    assert.deepEqual(state.tables.workspaces["legacy-project"].sessionIds, ["session-good"]);
    assert.equal(state.tables.workspaces["legacy-project"].path, fs.realpathSync(good));
    assert.equal(state.tables.workspaces["cca-project-qq-id"].title, "qqbot");
    assert.equal(state.tables.workspaces["cca-project-qq-id"].path, fs.realpathSync(qq));
    assert.deepEqual(state.tables.workspaces["cca-default"].sessionIds, ["session-old"]);
    assert.equal(state.tables.workspaces["cca-project-outside"], undefined);
    assert.deepEqual(state.global.archivedSessionIds, ["session-archived"]);

    ensureDshWorkspace(root, workspace, [
      { id: "good-id", name: "good renamed", path: good },
    ]);
    const updated = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(updated.tables.workspaces["legacy-project"].title, "good renamed");
    assert.deepEqual(updated.tables.workspaces["legacy-project"].sessionIds, ["session-good"]);
    assert.ok(updated.global.workspaceIds.includes("cca-project-qq-id"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("DSH profile copies the module tree into the active profile and keeps the user patch", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cca-dsh-profile-"));
  try {
    const template = path.join(root, "template");
    fs.mkdirSync(path.join(template, "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(template, "package.json"), '{"name":"template"}');
    fs.writeFileSync(path.join(template, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    fs.writeFileSync(path.join(template, "pnpm-workspace.yaml"), "packages:\n  - .\n");
    fs.writeFileSync(path.join(template, "cordis.patch.yml"), "[]\n");

    const home = path.join(root, "home");
    const profile = path.join(home, "profiles", "web");
    fs.mkdirSync(profile, { recursive: true });
    fs.writeFileSync(path.join(profile, "cordis.patch.yml"), "# user layer\n[]\n");
    fs.symlinkSync(path.join(root, "missing"), path.join(profile, "node_modules"), "dir");

    ensureDshProfile(home, template);
    assert.equal(fs.lstatSync(path.join(profile, "node_modules")).isDirectory(), true);
    assert.equal(fs.lstatSync(path.join(profile, "node_modules")).isSymbolicLink(), false);
    assert.equal(fs.existsSync(path.join(profile, ".cca-node-modules.sha256")), true);
    assert.equal(fs.readFileSync(path.join(profile, "cordis.patch.yml"), "utf8"), "# user layer\n[]\n");
    assert.equal(fs.readFileSync(path.join(profile, "package.json"), "utf8"), '{"name":"template"}');
    fs.writeFileSync(path.join(profile, "node_modules", "sentinel"), "keep");
    ensureDshProfile(home, template);
    assert.equal(fs.readFileSync(path.join(profile, "node_modules", "sentinel"), "utf8"), "keep");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("DSH SSH config is loaded through a PATH wrapper", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cca-dsh-ssh-"));
  try {
    const binDir = writeDshSshConfig(root, {
      host: "192.0.2.10",
      user: "sandbox",
      identityFile: path.join(root, "id_ed25519"),
      knownHostsFile: path.join(root, "known_hosts"),
      syncIdentityFile: path.join(root, "sync_ed25519"),
    });
    assert.equal(binDir, path.join(root, "bin"));
    const wrapper = fs.readFileSync(path.join(binDir, "ssh"), "utf8");
    assert.match(wrapper, /^#!\/bin\/sh/);
    assert.match(wrapper, /-F/);
    assert.match(wrapper, /config/);
    assert.equal(fs.statSync(path.join(binDir, "ssh")).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(binDir, "rsync-ssh")).mode & 0o777, 0o700);
    const config = fs.readFileSync(path.join(root, ".ssh", "config"), "utf8");
    assert.match(config, /Host cca-sandbox/);
    assert.match(config, /HostName '192\.0\.2\.10'/);
    assert.match(config, /Host cca-workspace-sync/);
    assert.match(config, /sync_ed25519/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
