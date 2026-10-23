import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveModelContextWindowTokens } from "@cca/protocol";
import type { AppSettings, ModelEntry, ModelProviderConfig } from "@cca/protocol";

export interface DshGatewayRoute {
  provider: ModelProviderConfig;
  providerName: string;
  apiKeyEnv: string;
  url: string;
}

export interface DshSandboxConfig {
  enabled: boolean;
  host: string;
  user: string;
  identityFile: string;
  knownHostsFile: string;
  helper: string;
  helperHash: string;
  workspace: string;
  tmpdir: string;
  syncEnabled?: boolean;
  syncIdentityFile?: string;
  hostWorkspace?: string;
}

export interface DshProfileOptions {
  homeDir: string;
  templateDir: string;
  settings: AppSettings;
  routes: DshGatewayRoute[];
  sandbox: DshSandboxConfig;
  overlayPath: string;
}

export interface DshIntegration {
  defaultModel: { provider: string; model: string };
  patch: unknown[];
}

/** Absolute directories of the vendored client UI plugins enabled for this launch. */
export interface DshUiPlugins {
  brand?: string;
  sidebar?: string;
  layout?: string;
}

/**
 * Replace a stock client UI row with a vendored package directory. The local
 * sidebar keeps the stock package name so every other plugin's declared
 * `dsh.client.inject` edge resolves to it.
 */
function uiOverride(id: string, disabledId: string, dir: string | undefined): unknown[] {
  if (!dir) return [];
  return [
    { id: disabledId, disabled: true },
    { insert: [{ id, name: dir }] },
  ];
}

const SSH_PROVIDER_ROWS = [
  { id: "subprocess-ssh", name: "@deepseek-ai/dsh-subprocess-ssh" },
  { id: "sandbox-ssh", name: "@deepseek-ai/dsh-sandbox-ssh" },
  { id: "fs-ssh", name: "@deepseek-ai/dsh-fs-ssh" },
];

function reasoningEfforts(model: ModelEntry): Record<string, string | null> | false {
  const supported = model.supportedReasoningEfforts?.filter(
    (effort, index, values) => values.indexOf(effort) === index,
  );
  if (!supported?.length || !supported.some((effort) => effort !== "none")) return false;

  const mapped: Record<string, string | null> = {};
  for (const effort of supported) {
    mapped[effort === "none" ? "off" : effort] = effort === "none" ? null : effort;
  }
  return mapped;
}

function routeForModel(settings: AppSettings, provider: ModelProviderConfig, model: ModelEntry) {
  const contextWindow = resolveModelContextWindowTokens(settings, {
    providerId: provider.id,
    modelId: model.id,
  });
  return {
    id: model.id,
    name: model.name?.trim() || model.id,
    ...(contextWindow ? { contextWindow } : {}),
    maxTokens: 32_768,
    reasoningEfforts: reasoningEfforts(model),
  };
}

/**
 * Build the DSH patch that replaces host process/file providers with the
 * deployment's SSH/Docker sandbox and routes model traffic through CCA's
 * Responses gateway. The profile's own patch stays user-editable; this overlay
 * only owns the integration rows and is regenerated on every DSH launch.
 */
export function buildDshIntegration(
  settings: AppSettings,
  routes: readonly DshGatewayRoute[],
  sandbox: DshSandboxConfig,
  ui: DshUiPlugins = {},
): DshIntegration {
  if (routes.length === 0) {
    throw new Error("没有可用于 DSH 的 OpenAI 兼容模型提供方");
  }

  const routeByProviderId = new Map(routes.map((route) => [route.provider.id, route]));
  const usableRoutes = routes.filter((route) => route.provider.models.length > 0);
  if (usableRoutes.length === 0) {
    throw new Error("模型提供方均未配置模型，无法启动 DeepSeek Harness");
  }

  const preferred = settings.defaultModel;
  const preferredRoute = preferred ? routeByProviderId.get(preferred.providerId) : undefined;
  const preferredModel = preferredRoute?.provider.models.find(
    (model) => model.id === preferred?.modelId,
  );
  const fallbackRoute = usableRoutes[0];
  const fallbackModel = fallbackRoute?.provider.models[0];
  if (!fallbackRoute || !fallbackModel) {
    throw new Error("模型提供方均未配置模型，无法启动 DeepSeek Harness");
  }
  const defaultRoute = preferredRoute && preferredModel ? preferredRoute : fallbackRoute;
  const defaultModel = preferredRoute && preferredModel ? preferredModel : fallbackModel;

  const providers = Object.fromEntries(
    usableRoutes.map((route) => [
      route.providerName,
      {
        displayName: route.provider.name || route.provider.id,
        api: "openai-responses",
        baseURL: route.url,
        apiKeyEnv: route.apiKeyEnv,
        models: route.provider.models.map((model) => routeForModel(settings, route.provider, model)),
      },
    ]),
  );

  const sandboxRows = sandbox.enabled
    ? [
        {
          id: "ssh",
          name: "@deepseek-ai/dsh-ssh",
          config: {
            host: "cca-sandbox",
            launch: { kind: "node-script", node: "/usr/local/bin/node" },
            helper: sandbox.helper,
            helperHash: sandbox.helperHash,
            workspace: sandbox.workspace,
            requestTimeoutMs: 30_000,
            leaseMs: 30_000,
          },
        },
        ...SSH_PROVIDER_ROWS,
      ]
    : [];

  return {
    defaultModel: { provider: defaultRoute.providerName, model: defaultModel.id },
    patch: [
      {
        id: "agent-default-model",
        config: { provider: defaultRoute.providerName, model: defaultModel.id },
      },
      {
        id: "sandbox-policy",
        config: {
          mode: "danger-full-access",
          workspaceRoot: sandbox.workspace,
        },
      },
      {
        id: "approval",
        config: { policy: "never" },
      },
      {
        id: "permission",
        config: {
          defaultPreset: "danger-full-access",
          presets: {
            "read-only": { sandbox: "read-only", approval: "ask" },
            "workspace-write": { sandbox: "workspace-write", approval: "ask" },
            "danger-full-access": { sandbox: "danger-full-access", approval: "never" },
          },
        },
      },
      { id: "open-in-app", disabled: true },
      { id: "ui-open-in-app", disabled: true },
      ...(sandbox.enabled
        ? [
            { id: "subprocess", disabled: true },
            { id: "sandbox", disabled: true },
            { id: "fs-sandbox", disabled: true },
          ]
        : []),
      {
        id: "llm-pi-ai",
        config: { providers },
      },
      ...(sandboxRows.length > 0 ? [{ insert: sandboxRows }] : []),
      ...uiOverride("cca-brand", "ui-brand-official", ui.brand),
      ...uiOverride("cca-sidebar", "ui-sidebar", ui.sidebar),
      ...uiOverride("cca-layout", "ui-layout", ui.layout),
    ],
  };
}

function copyFileIfPresent(sourceDir: string, targetDir: string, name: string) {
  const source = path.join(sourceDir, name);
  if (!fs.existsSync(source)) return;
  fs.copyFileSync(source, path.join(targetDir, name));
}

/**
 * Materialize the package files of the image-shipped profile without copying
 * its large node_modules tree. The symlink keeps the persistent profile's
 * dependency closure tied to the image version while sessions and settings
 * remain under DSH_HOME.
 */
export function ensureDshProfile(homeDir: string, templateDir: string): string {
  const profileDir = path.join(homeDir, "profiles", "web");
  const templatePackage = path.join(templateDir, "package.json");
  const templateModules = path.join(templateDir, "node_modules");
  if (!fs.existsSync(templatePackage) || !fs.existsSync(templateModules)) {
    throw new Error(`DSH profile 镜像模板不完整: ${templateDir}`);
  }
  fs.mkdirSync(profileDir, { recursive: true });

  // These files describe the image-owned dependency closure. Refresh them on
  // every launch so a persistent DSH_HOME cannot keep a profile installed with
  // an older (or broken) package layout. The user patch remains untouched.
  for (const name of [
    "package.json",
    "pnpm-workspace.yaml",
    "pnpm-lock.yaml",
    "cordis.patch.yml",
  ]) {
    if (name === "cordis.patch.yml" && fs.existsSync(path.join(profileDir, name))) continue;
    copyFileIfPresent(templateDir, profileDir, name);
  }

  // DSH installs its runtime resolver by identifying modules inside the active
  // profile. A symlink to a shared node_modules tree loads modules by their
  // real path and silently bypasses that resolver, so provider packages cannot
  // reach DSH's single-instance core peers. Keep a real copy in the profile and
  // use a content marker to make image updates idempotent.
  const profileModules = path.join(profileDir, "node_modules");
  const marker = path.join(profileDir, ".cca-node-modules.sha256");
  const digest = createHash("sha256");
  for (const name of ["package.json", "pnpm-lock.yaml"]) {
    const file = path.join(templateDir, name);
    digest.update(name);
    digest.update(fs.existsSync(file) ? fs.readFileSync(file) : Buffer.from(""));
  }
  const expectedMarker = digest.digest("hex");
  let currentMarker: string | undefined;
  try {
    currentMarker = fs.readFileSync(marker, "utf8").trim();
  } catch {
    currentMarker = undefined;
  }
  let modulesAreRealDirectory = false;
  try {
    modulesAreRealDirectory = fs.lstatSync(profileModules).isDirectory();
  } catch {
    modulesAreRealDirectory = false;
  }
  if (modulesAreRealDirectory && currentMarker === expectedMarker) return profileDir;

  const staging = path.join(profileDir, ".node_modules.cca-staging");
  fs.rmSync(staging, { recursive: true, force: true });
  fs.cpSync(templateModules, staging, { recursive: true, dereference: false });
  fs.rmSync(profileModules, { recursive: true, force: true });
  fs.renameSync(staging, profileModules);
  const temporaryMarker = `${marker}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryMarker, `${expectedMarker}\n`, { mode: 0o600 });
  fs.renameSync(temporaryMarker, marker);
  return profileDir;
}

export function writeDshOverlay(overlayPath: string, patch: unknown[]): void {
  fs.mkdirSync(path.dirname(overlayPath), { recursive: true });
  const temporary = `${overlayPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(patch, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, overlayPath);
}

function sshQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function writeDshSshConfig(
  homeDir: string,
  sandbox: Pick<DshSandboxConfig, "host" | "user" | "identityFile" | "knownHostsFile"> & {
    syncIdentityFile?: string;
  },
): string {
  const sshDir = path.join(homeDir, ".ssh");
  fs.mkdirSync(sshDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(sshDir, 0o700);
  const lines = [
    "Host cca-sandbox",
    `  HostName ${sshQuote(sandbox.host)}`,
    `  User ${sshQuote(sandbox.user)}`,
    `  IdentityFile ${sshQuote(sandbox.identityFile)}`,
    "  IdentitiesOnly yes",
    "  BatchMode yes",
    "  StrictHostKeyChecking yes",
    `  UserKnownHostsFile ${sshQuote(sandbox.knownHostsFile)}`,
    "  ConnectTimeout 10",
    "  ServerAliveInterval 10",
    "  ServerAliveCountMax 3",
  ];
  if (sandbox.syncIdentityFile) {
    lines.push(
      "",
      "Host cca-workspace-sync",
      `  HostName ${sshQuote(sandbox.host)}`,
      `  User ${sshQuote(sandbox.user)}`,
      `  IdentityFile ${sshQuote(sandbox.syncIdentityFile)}`,
      "  IdentitiesOnly yes",
      "  BatchMode yes",
      "  StrictHostKeyChecking yes",
      `  UserKnownHostsFile ${sshQuote(sandbox.knownHostsFile)}`,
      "  ConnectTimeout 10",
    );
  }
  lines.push("");
  const config = lines.join("\n");
  const configPath = path.join(sshDir, "config");
  fs.writeFileSync(configPath, config, { mode: 0o600 });
  fs.chmodSync(configPath, 0o600);

  // OpenSSH resolves ~/.ssh from the passwd database, not HOME. Place a
  // wrapper first on DSH's PATH so its subprocess providers use this config
  // regardless of the container user's real home directory.
  const binDir = path.join(homeDir, "bin");
  fs.mkdirSync(binDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(binDir, 0o700);
  const wrapper = path.join(binDir, "ssh");
  const sshBinary = process.env.DSH_SSH_BIN?.trim() || "/usr/bin/ssh";
  const script = `#!/bin/sh\nexec ${sshQuote(sshBinary)} -F ${sshQuote(configPath)} "$@"\n`;
  fs.writeFileSync(wrapper, script, { mode: 0o700 });
  fs.chmodSync(wrapper, 0o700);
  const rsyncWrapper = path.join(binDir, "rsync-ssh");
  fs.writeFileSync(rsyncWrapper, script, { mode: 0o700 });
  fs.chmodSync(rsyncWrapper, 0o700);
  return binDir;
}

interface StoredWorkspaceRecord {
  path?: string;
  title?: string;
  sessionIds?: string[];
  createdAt?: string;
  updatedAt?: string;
}

interface StoredWorkspaceState {
  unit?: { name?: string; version?: number };
  global?: {
    initialized?: boolean;
    defaultWorkspaceId?: string;
    workspaceIds?: string[];
    archivedSessionIds?: string[];
    pinnedSessionIds?: string[];
  };
  tables?: { workspaces?: Record<string, StoredWorkspaceRecord> };
}

export interface DshWorkspaceProject {
  id: string;
  name: string;
  path: string;
  ownerId?: string;
}

export function dshUserKey(username: string): string {
  if (!username.trim()) throw new Error("DSH 用户无效");
  return createHash("sha256").update(username).digest("hex");
}

function canonicalWorkspacePath(candidate: string): string {
  try {
    return fs.realpathSync(candidate);
  } catch {
    // DSH only needs a stable spelling here; the remote path is authoritative.
    return path.isAbsolute(candidate) && !candidate.startsWith("/")
      ? path.resolve(candidate)
      : path.posix.resolve(candidate);
  }
}

function isWorkspaceChild(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/**
 * Reconcile the DSH workspace registry with the CCA project catalogue. DSH's
 * registry runs on the CCA host and therefore needs real host paths; process
 * and file providers still execute every path through SSH in Docker. Only
 * projects below the sandbox workspace root are exposed because paths outside
 * that mount do not exist in the sandbox.
 */
export function ensureDshWorkspace(
  homeDir: string,
  workspacePath: string,
  projects: readonly DshWorkspaceProject[] = [],
  scope?: { ownerId: string; fallbackPath: string },
): void {
  const file = path.join(homeDir, "storages", "workspace.json");
  let current: StoredWorkspaceState | undefined;
  try {
    current = JSON.parse(fs.readFileSync(file, "utf8")) as StoredWorkspaceState;
  } catch {
    current = undefined;
  }

  const workspaceIds = Array.isArray(current?.global?.workspaceIds)
    ? current.global.workspaceIds.filter((id): id is string => typeof id === "string")
    : [];
  const workspaces = { ...(current?.tables?.workspaces ?? {}) };
  const existingIds = [
    ...workspaceIds,
    ...Object.keys(workspaces).filter((id) => !workspaceIds.includes(id)),
  ];
  const catalogRoot = canonicalWorkspacePath(workspacePath);
  const rootPath = canonicalWorkspacePath(scope?.fallbackPath ?? workspacePath);
  const now = new Date().toISOString();

  const findIdByPath = (candidate: string) =>
    existingIds.find((id) => workspaces[id]?.path === candidate);
  const rootId = findIdByPath(rootPath);
  let resolvedRootId = rootId;
  if (!resolvedRootId) {
    resolvedRootId = "cca-default";
    workspaces[resolvedRootId] = {
      path: rootPath,
      title: scope ? "个人工作区" : "工作区",
      sessionIds: [],
      createdAt: now,
      updatedAt: now,
    };
  }

  const projectIds: string[] = [];
  const claimedIds = new Set<string>([resolvedRootId]);
  for (const project of projects) {
    if (scope && project.ownerId !== scope.ownerId) continue;
    const projectPath = canonicalWorkspacePath(project.path);
    if (!isWorkspaceChild(projectPath, catalogRoot)) continue;
    const id = findIdByPath(projectPath) ?? `cca-project-${project.id}`;
    if (claimedIds.has(id)) continue;
    const title = project.name.trim() || project.id;
    const existing = workspaces[id];
    if (!existing) {
      workspaces[id] = {
        path: projectPath,
        title,
        sessionIds: [],
        createdAt: now,
        updatedAt: now,
      };
    } else {
      const sessionIds = Array.isArray(existing.sessionIds)
        ? existing.sessionIds.filter((sessionId): sessionId is string => typeof sessionId === "string")
        : [];
      const changed = existing.path !== projectPath || existing.title !== title;
      workspaces[id] = {
        ...existing,
        path: projectPath,
        title,
        sessionIds,
        createdAt: typeof existing.createdAt === "string" ? existing.createdAt : now,
        updatedAt: changed || typeof existing.updatedAt !== "string" ? now : existing.updatedAt,
      };
    }
    claimedIds.add(id);
    if (!existingIds.includes(id)) existingIds.push(id);
    projectIds.push(id);
  }

  const orderedIds = [...new Set([
    ...projectIds, resolvedRootId, ...(scope ? [] : existingIds),
  ])];
  const visibleWorkspaces: Record<string, StoredWorkspaceRecord> = {};
  for (const id of orderedIds) {
    const workspace = workspaces[id];
    if (workspace) visibleWorkspaces[id] = workspace;
  }
  const visibleSessionIds = new Set(orderedIds.flatMap((id) => workspaces[id]?.sessionIds ?? []));
  const sessionIds = (values: unknown) => Array.isArray(values)
    ? values.filter((id): id is string => typeof id === "string" && (!scope || visibleSessionIds.has(id)))
    : [];
  const state: StoredWorkspaceState = {
    unit: { name: "workspace", version: 2 },
    global: {
      ...current?.global,
      initialized: true,
      workspaceIds: orderedIds,
      defaultWorkspaceId: projectIds[0] ?? resolvedRootId,
      archivedSessionIds: sessionIds(current?.global?.archivedSessionIds),
      pinnedSessionIds: sessionIds(current?.global?.pinnedSessionIds),
    },
    tables: { ...current?.tables, workspaces: visibleWorkspaces },
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, file);
}

export function providerRouteName(providerId: string, index: number): string {
  const slug = providerId.replace(/[^a-zA-Z0-9_]/g, "_");
  return `cca_${slug || "provider"}_${index}`;
}

export function apiKeyEnvName(index: number): string {
  return `CCA_DSH_GATEWAY_KEY_${index}`;
}

export function isUsableDshProvider(provider: ModelProviderConfig): boolean {
  return provider.type !== "anthropic" && provider.models.length > 0;
}
