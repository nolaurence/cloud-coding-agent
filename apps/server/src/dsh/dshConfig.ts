// DeepSeek Harness 运行时（dsh --profile sdk）的部署配置生成。
//
// SDK 协议的 initialize 只携带 cwd/provider/model/maxTokens，其余组合（模型路由、MCP、
// 技能、沙箱）都由运行时自己的配置树决定：这里生成会话专属 $DSH_HOME（skills/ 软链）与
// --patch 覆盖层（llm-pi-ai 模型路由行、MCP 客户端行、沙箱策略行），spawn 前写盘。
//
// 注意：配置文件内容一律输出 JSON 文本——YAML 1.2 是 JSON 的超集，js-yaml 可直接解析，
// 避免手写 YAML 字符串转义出错。
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { PermissionMode } from "@cca/protocol";

/** DSH 沙箱模式（dsh-sandbox 的 SandboxMode 词汇）。 */
export type DshSandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export interface DshProviderRoute {
  /** 路由 key = 应用侧 provider id（initialize.provider 使用同一值）。 */
  id: string;
  type: "openai" | "azure" | "anthropic";
  baseUrl: string;
  apiKey?: string;
  wireApi?: "completions" | "responses";
  headers?: Record<string, string>;
  azure?: { apiVersion: string };
  models: { id: string; name?: string }[];
  defaultContextWindow?: number;
}

/** DSH mcp-client 插件的配置形状（transport 判别，toolCallTimeoutMs/failOnStartupError 由 patch 生成器补齐）。 */
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

/**
 * 生成 --patch 覆盖层：模型路由（llm-pi-ai 行）+ MCP 客户端行 + 沙箱策略行。
 *
 * 已实测验证（dsh 0.2.1-rc.2）：SDK profile 里 settings 插件被禁用（无 profileContext），
 * 因此模型路由必须以 patch 行 config 的形式挂载（insert 同 id 行会整行替换），
 * 而不是写 settings.yaml。patch 文档 = YAML 列表，元素为 { insert: rows }；JSON 文本即合法 YAML。
 */
export function patchDocFor(
  routes: readonly DshProviderRoute[],
  mcpRows: readonly DshMcpRow[],
  sandboxMode: DshSandboxMode,
  workspaceRoot: string,
): unknown {
  const providers: Record<string, unknown> = {};
  for (const route of routes) {
    providers[route.id] = {
      apiKeyEnv: credentialEnvName(route.id),
      displayName: route.id,
      api: piAiApiFor(route.type, route.wireApi),
      baseURL: route.baseUrl,
      ...(route.headers ? { headers: route.headers } : {}),
      ...(route.defaultContextWindow ? { defaultContextWindow: route.defaultContextWindow } : {}),
      models: route.models.map((model) => ({ id: model.id })),
    };
  }
  const rows: unknown[] = [
    {
      id: "llm-pi-ai",
      name: "@deepseek-ai/dsh-llm-pi-ai",
      config: { providers },
    },
    {
      id: "sandbox-policy",
      name: "@deepseek-ai/dsh-sandbox-policy",
      config: { mode: sandboxMode, workspaceRoot },
    },
  ];
  for (const row of mcpRows) {
    rows.push({
      id: row.id,
      name: "@deepseek-ai/dsh-mcp-client",
      config: {
        ...row.config,
        serverName: row.serverName,
        toolCallTimeoutMs: row.timeoutMs ?? 60_000,
        failOnStartupError: false,
      },
    });
  }
  return [{ insert: rows }];
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
 * 写出一个完整的会话级 $DSH_HOME：skills 软链（skill-filesystem 的用户根发现路径）
 * 与 --patch 覆盖层。幂等：重复调用会重建 skills 软链与 patch 文件。
 */
export function prepareDshHome(setup: DshHomeSetup, routes: readonly DshProviderRoute[]): { patchPath: string } {
  const skillsRoot = path.join(setup.homeDir, "skills");
  fs.mkdirSync(skillsRoot, { recursive: true });

  // 已启用技能 → $DSH_HOME/skills/<name>（skill-filesystem 的用户根目录发现路径）
  for (const dir of setup.skillDirs) {
    for (const name of readSkillNames(dir)) {
      if (setup.disabledSkills.includes(name)) continue;
      linkSkill(skillsRoot, name, path.join(dir, name));
    }
  }
  // 被禁用的技能确保不存在
  for (const name of setup.disabledSkills) {
    fs.rmSync(path.join(skillsRoot, name), { recursive: true, force: true });
  }

  const patchPath = path.join(setup.homeDir, "cca.patch.json");
  fs.writeFileSync(
    patchPath,
    patchYamlFor(routes, setup.mcpRows, setup.sandboxMode, setup.workspaceRoot),
    "utf8",
  );
  return { patchPath };
}

/** spawn 运行时的命令解析：CCA_DSH_PATH 优先，否则用安装的 @deepseek-ai/dsh CLI。 */
export function dshRuntimeCommand(): { command: string; prefixArgs: string[] } {
  const override = process.env.CCA_DSH_PATH?.trim();
  if (override) return { command: override, prefixArgs: [] };
  return { command: process.execPath, prefixArgs: [dshCliEntry()] };
}

export function dshCliEntry(): string {
  // apps/server 与 @deepseek-ai/dsh 同装于 node_modules；解析失败时给出可操作报错。
  const require = createRequire(import.meta.url);
  const entry = path.join(path.dirname(require.resolve("@deepseek-ai/dsh/package.json")), "lib", "bin.js");
  return entry.replace(/app\.asar([\\/])/, "app.asar.unpacked$1");
}

/** 运行时启动参数：`dsh --profile sdk --patch <file>`，stdio 专用于 JSON-RPC 帧。 */
export function dshRuntimeArgs(patchPath: string): string[] {
  return [...dshRuntimeCommand().prefixArgs, "--profile", "sdk", "--patch", patchPath];
}
