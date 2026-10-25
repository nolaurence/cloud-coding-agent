// DeepSeek Harness 运行时（dsh --profile sdk）的部署配置生成。
//
// SDK 协议的 initialize 只携带 cwd/provider/model，其余组合（模型路由、MCP、技能、
// 沙箱、审批）都由运行时自己的配置树决定：这里生成会话专属 $DSH_HOME（skills/ 软链）
// 与 --patch 覆盖层（llm-pi-ai 模型路由、MCP 客户端、沙箱策略），spawn 前写盘。
//
// 配置文件内容一律输出 JSON 文本——YAML 1.2 是 JSON 的超集，js-yaml 可直接解析，
// 避免手写 YAML 字符串转义出错。
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { PermissionMode, ReasoningEffort } from "@cca/protocol";

/** DSH 沙箱模式（dsh-sandbox 的 SandboxMode 词汇）。 */
export type DshSandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export interface DshProviderRoute {
  /** 路由 key = initialize.provider 使用的值。 */
  id: string;
  type: "openai" | "azure" | "anthropic";
  baseUrl: string;
  apiKey?: string;
  wireApi?: "completions" | "responses";
  headers?: Record<string, string>;
  reasoningEffort?: ReasoningEffort;
  models: { id: string; name?: string; contextWindow?: number }[];
}

/** DSH mcp-client 插件的配置形状（transport 判别，超时/启动失败策略由生成器补齐）。 */
export type DshMcpPluginConfig =
  | {
      transport: "stdio";
      serverName: string;
      command: string;
      args: string[];
      env: Record<string, string>;
      cwd: string;
    }
  | {
      transport: "streamable-http";
      serverName: string;
      url: string;
      headers: Record<string, string>;
    };

export interface DshMcpRow {
  /** patch 行 id（稳定、可替换）。 */
  id: string;
  serverName: string;
  config: DshMcpPluginConfig;
  timeoutMs?: number;
}

export interface DshHomeSetup {
  homeDir: string;
  /** 需要软链进 $DSH_HOME/skills 的技能目录（<dir>/<name>/SKILL.md 的 <dir>）。 */
  skillDirs: string[];
  disabledSkills: string[];
  mcpRows: DshMcpRow[];
  sandboxMode: DshSandboxMode;
  workspaceRoot: string;
}

export function sandboxModeFor(permissionMode: PermissionMode | undefined): DshSandboxMode {
  switch (permissionMode) {
    case "full":
      return "danger-full-access";
    case "request":
    case "auto":
      return "workspace-write";
    default:
      return "workspace-write";
  }
}

/** 应用 provider 配置 → pi-ai 适配器的线协议名。 */
export function piAiApiFor(
  type: "openai" | "azure" | "anthropic",
  wireApi: "completions" | "responses" | undefined,
): string {
  if (type === "anthropic") return "anthropic-messages";
  return (wireApi ?? "completions") === "responses" ? "openai-responses" : "openai-completions";
}

/** 应用推理强度 → pi-ai 的 reasoning 词汇。 */
export function piAiReasoningFor(effort: ReasoningEffort | undefined): string | undefined {
  if (!effort) return undefined;
  return effort === "none" ? "off" : effort;
}

export function credentialEnvName(providerId: string): string {
  return "CCA_DSH_KEY_" + providerId.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

function readSkillNames(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name)
      .filter((name) => fs.existsSync(path.join(dir, name, "SKILL.md")));
  } catch {
    return [];
  }
}

function linkSkill(targetRoot: string, name: string, source: string) {
  const link = path.join(targetRoot, name);
  try {
    fs.rmSync(link, { recursive: true, force: true });
    fs.symlinkSync(source, link, "junction");
  } catch {
    // 软链失败（权限/跨盘）时退化为复制 SKILL.md 所在目录
    fs.cpSync(source, link, { recursive: true });
  }
}

function providerRow(route: DshProviderRoute): unknown {
  const reasoning = piAiReasoningFor(route.reasoningEffort);
  return {
    apiKeyEnv: route.apiKey ? credentialEnvName(route.id) : undefined,
    displayName: route.id,
    api: piAiApiFor(route.type, route.wireApi),
    baseURL: route.baseUrl,
    ...(route.headers ? { headers: route.headers } : {}),
    ...(reasoning ? { reasoning } : {}),
    models: route.models.map((model) => ({
      id: model.id,
      ...(model.name ? { name: model.name } : {}),
      ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
    })),
  };
}

const PERMISSION_PRESETS = {
  "read-only": { sandbox: "read-only", approval: "never" },
  "workspace-write": { sandbox: "workspace-write", approval: "never" },
  "danger-full-access": { sandbox: "danger-full-access", approval: "never" },
} as const;

/**
 * 生成 --patch 覆盖层：
 * - llm-pi-ai：本会话唯一的模型路由（BYOK；apiKey 只以环境变量引用形式出现）
 * - agent-default-model：子代理继承同一路由
 * - sandbox-policy / approval / permission：文件沙箱 + 非交互审批
 * - insert：每个 MCP 服务器一行 mcp-client 插件
 */
export function patchDocFor(
  routes: readonly DshProviderRoute[],
  mcpRows: readonly DshMcpRow[],
  sandboxMode: DshSandboxMode,
  workspaceRoot: string,
): unknown {
  const providers: Record<string, unknown> = {};
  for (const route of routes) providers[route.id] = providerRow(route);
  const firstRoute = routes[0];
  const firstModel = firstRoute?.models[0];
  const rows: unknown[] = [
    { id: "llm-pi-ai", config: { providers } },
    { id: "sandbox-policy", config: { mode: sandboxMode, workspaceRoot } },
    { id: "approval", config: { policy: "never" } },
    {
      id: "permission",
      config: { defaultPreset: sandboxMode, presets: PERMISSION_PRESETS },
    },
  ];
  if (firstRoute && firstModel) {
    rows.push({
      id: "agent-default-model",
      config: { provider: firstRoute.id, model: firstModel.id },
    });
  }
  const mcpInserts = mcpRows.map((row) => ({
    id: row.id,
    name: "@deepseek-ai/dsh-mcp-client",
    config: {
      ...row.config,
      serverName: row.serverName,
      toolCallTimeoutMs: row.timeoutMs ?? 60_000,
      failOnStartupError: false,
    },
  }));
  if (mcpInserts.length > 0) rows.push({ insert: mcpInserts });
  return rows;
}

export function patchYamlFor(
  routes: readonly DshProviderRoute[],
  mcpRows: readonly DshMcpRow[],
  sandboxMode: DshSandboxMode,
  workspaceRoot: string,
): string {
  return JSON.stringify(patchDocFor(routes, mcpRows, sandboxMode, workspaceRoot), null, 2);
}

/**
 * 写出一个完整的会话级 $DSH_HOME：profiles（CLI 初始化 sdk profile 需要父目录存在）、
 * skills 软链（skill-filesystem 的用户根发现路径）与 --patch 覆盖层。
 * 幂等：重复调用会重建 skills 软链与 patch 文件。
 */
export function prepareDshHome(
  setup: DshHomeSetup,
  routes: readonly DshProviderRoute[],
): { patchPath: string } {
  fs.mkdirSync(setup.homeDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(setup.homeDir, "profiles"), { recursive: true, mode: 0o700 });
  const skillsRoot = path.join(setup.homeDir, "skills");
  fs.mkdirSync(skillsRoot, { recursive: true, mode: 0o700 });

  // 已启用技能 → $DSH_HOME/skills/<name>（skill-filesystem 的用户根目录发现路径）
  const linkedSkills = new Set<string>();
  for (const dir of setup.skillDirs) {
    for (const name of readSkillNames(dir)) {
      if (setup.disabledSkills.includes(name)) continue;
      linkSkill(skillsRoot, name, path.join(dir, name));
      linkedSkills.add(name);
    }
  }
  // 被禁用的技能确保不存在
  for (const name of setup.disabledSkills) {
    fs.rmSync(path.join(skillsRoot, name), { recursive: true, force: true });
  }
  // 清理已从应用删除/停用的旧技能链接（保留 DSH 自己的 .system 目录）
  for (const name of fs.readdirSync(skillsRoot)) {
    if (name === ".system" || linkedSkills.has(name)) continue;
    const candidate = path.join(skillsRoot, name);
    if (fs.existsSync(path.join(candidate, "SKILL.md"))) {
      fs.rmSync(candidate, { recursive: true, force: true });
    }
  }

  const patchPath = path.join(setup.homeDir, "cca.patch.json");
  fs.writeFileSync(
    patchPath,
    patchYamlFor(routes, setup.mcpRows, setup.sandboxMode, setup.workspaceRoot),
    { encoding: "utf8", mode: 0o600 },
  );
  try {
    fs.chmodSync(patchPath, 0o600);
  } catch {
    // Windows 上 chmod 语义有限；文件仍位于 0700 的会话目录内。
  }
  return { patchPath };
}

/** 解析 dsh CLI 的 JS 入口：CCA_DSH_PATH / DSH_BIN 优先，否则用同版本的 @deepseek-ai/dsh。 */
// 重要：apps/server 必须把 @deepseek-ai/{cordis,dsh-llm,dsh-sdk-protocol,dsh-session}
// 声明为直接依赖。否则 npm 会把 SDK client 的 peer deps 装到 apps/server/node_modules，
// 同时在 @deepseek-ai/dsh 的插件树里再嵌套一份；Cordis 的 Symbol 跨副本不相等，
// 工具调度器会丢失，表现为 "Cannot read properties of undefined (reading 'prepare')"。
export function dshBinPath(): string {
  const override = process.env.CCA_DSH_PATH?.trim() || process.env.DSH_BIN?.trim();
  if (override) return override;
  return dshCliEntry();
}

export function dshCliEntry(): string {
  // apps/server 与 @deepseek-ai/dsh 同装于 node_modules；解析失败时给出可操作报错。
  const require = createRequire(import.meta.url);
  const entry = path.join(path.dirname(require.resolve("@deepseek-ai/dsh/package.json")), "lib", "bin.js");
  return entry.replace(/app\.asar([\\/])/, "app.asar.unpacked$1");
}
