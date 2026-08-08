import fs from "node:fs";
import path from "node:path";
import type { McpServerConfig, ResourceScope } from "@cca/protocol";
import type { MCPServerConfig } from "@github/copilot-sdk";
import { store } from "./store.js";

const MCP_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/;
const WORKSPACE_MCP_FILE = ".mcp.json";

type WorkspaceMcpDocument = { mcpServers: Record<string, unknown> };

export function normalizeMcpServer(
  value: Partial<McpServerConfig>,
  existing?: McpServerConfig,
): McpServerConfig {
  const merged = { ...existing, ...value };
  const id = merged.id?.trim() ?? "";
  const name = merged.name?.trim() || id;
  if (!MCP_ID.test(id)) throw new Error("MCP 标识只能包含字母、数字、点、中划线和下划线，长度不超过 64 个字符");
  if (!name) throw new Error("MCP 名称必填");
  if (merged.type !== "local" && merged.type !== "http") throw new Error("MCP 类型必须是 local 或 http");
  const tools = [...new Set((merged.tools ?? ["*"]).map((tool) => tool.trim()).filter(Boolean))];
  if (merged.type === "local") {
    const command = merged.command?.trim();
    if (!command) throw new Error("本地 MCP 服务器需要启动命令");
    return {
      id,
      name,
      enabled: merged.enabled !== false,
      type: "local",
      command,
      args: merged.args?.map(String) ?? [],
      env: preserveRedactedValues(value.env, existing?.env) ?? {},
      ...(merged.cwd?.trim() ? { cwd: merged.cwd.trim() } : {}),
      tools: tools.length > 0 ? tools : ["*"],
      ...(merged.timeout !== undefined ? { timeout: normalizeTimeout(merged.timeout) } : {}),
    };
  }
  const url = merged.url?.trim();
  if (!url) throw new Error("HTTP MCP 服务器需要 URL");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("MCP URL 无效");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("MCP URL 必须使用 HTTP 或 HTTPS");
  }
  return {
    id,
    name,
    enabled: merged.enabled !== false,
    type: "http",
    url: parsed.toString(),
    headers: preserveRedactedValues(value.headers, existing?.headers) ?? {},
    tools: tools.length > 0 ? tools : ["*"],
    ...(merged.timeout !== undefined ? { timeout: normalizeTimeout(merged.timeout) } : {}),
  };
}

function preserveRedactedValues(
  values: Record<string, string> | undefined,
  existing: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!values) return existing;
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [
    key,
    value === "******" && existing?.[key] !== undefined ? existing[key] : value,
  ]));
}

function normalizeTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("MCP 超时时间必须是正整数毫秒");
  return value;
}

function workspaceMcpPath(workspacePath: string): string {
  const root = fs.realpathSync(workspacePath);
  const target = path.join(root, WORKSPACE_MCP_FILE);
  if (fs.existsSync(target) && !isInside(root, fs.realpathSync(target))) {
    throw new Error("工作区 .mcp.json 不能通过符号链接指向工作区外");
  }
  return target;
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative));
}

function parseWorkspaceServer(id: string, raw: unknown): McpServerConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`MCP ${id} 配置无效`);
  const value = raw as Record<string, unknown>;
  const rawType = value.type;
  const type = rawType === "http" || rawType === "sse" ? "http" : "local";
  return normalizeMcpServer({
    id,
    name: typeof value.name === "string" ? value.name : id,
    enabled: value.enabled !== false,
    type,
    command: typeof value.command === "string" ? value.command : undefined,
    args: Array.isArray(value.args) ? value.args.filter((item): item is string => typeof item === "string") : undefined,
    env: stringRecord(value.env),
    cwd: typeof value.cwd === "string"
      ? value.cwd
      : typeof value.workingDirectory === "string"
        ? value.workingDirectory
        : undefined,
    url: typeof value.url === "string" ? value.url : undefined,
    headers: stringRecord(value.headers),
    tools: Array.isArray(value.tools) ? value.tools.filter((item): item is string => typeof item === "string") : ["*"],
    timeout: typeof value.timeout === "number" ? value.timeout : undefined,
  });
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("MCP 键值配置必须是字符串对象");
  const entries = Object.entries(value);
  if (entries.some(([, item]) => typeof item !== "string")) throw new Error("MCP 键值配置只能包含字符串值");
  return Object.fromEntries(entries) as Record<string, string>;
}

export function listWorkspaceMcpServers(workspacePath: string): McpServerConfig[] {
  const file = workspaceMcpPath(workspacePath);
  if (!fs.existsSync(file)) return [];
  let document: unknown;
  try {
    document = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`工作区 .mcp.json 无法解析：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!document || typeof document !== "object" || Array.isArray(document)) throw new Error("工作区 .mcp.json 必须是对象");
  const servers = (document as Record<string, unknown>).mcpServers;
  if (servers === undefined) return [];
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) throw new Error("工作区 .mcp.json 的 mcpServers 必须是对象");
  return Object.entries(servers).map(([id, value]) => parseWorkspaceServer(id, value));
}

function writeWorkspaceMcpServers(workspacePath: string, servers: McpServerConfig[]): void {
  const file = workspaceMcpPath(workspacePath);
  const document: WorkspaceMcpDocument = { mcpServers: {} };
  for (const server of servers) {
    document.mcpServers[server.id] = server.type === "local"
      ? {
          name: server.name,
          enabled: server.enabled,
          type: "stdio",
          command: server.command,
          args: server.args ?? [],
          env: server.env ?? {},
          ...(server.cwd ? { workingDirectory: server.cwd } : {}),
          tools: server.tools,
          ...(server.timeout ? { timeout: server.timeout } : {}),
        }
      : {
          name: server.name,
          enabled: server.enabled,
          type: "http",
          url: server.url,
          headers: server.headers ?? {},
          tools: server.tools,
          ...(server.timeout ? { timeout: server.timeout } : {}),
        };
  }
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(document, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function listScopedMcpServers(scope: ResourceScope, workspacePath?: string): McpServerConfig[] {
  if (scope === "platform") return store.settings.mcpServers.map((server) => normalizeMcpServer(server));
  if (!workspacePath) throw new Error("工作区 MCP 操作缺少工作区路径");
  return listWorkspaceMcpServers(workspacePath);
}

export function saveScopedMcpServer(
  scope: ResourceScope,
  input: Partial<McpServerConfig>,
  workspacePath?: string,
  mode: "create" | "update" | "upsert" = "upsert",
): McpServerConfig {
  const servers = listScopedMcpServers(scope, workspacePath);
  const id = input.id?.trim() ?? "";
  const existing = servers.find((server) => server.id === id);
  if (mode === "create" && existing) throw new Error("MCP 服务器已存在");
  if (mode === "update" && !existing) throw new Error("MCP 服务器不存在");
  const saved = normalizeMcpServer(input, existing);
  const next = existing
    ? servers.map((server) => server.id === saved.id ? saved : server)
    : [...servers, saved];
  if (scope === "platform") store.saveSettings({ ...store.settings, mcpServers: next });
  else if (workspacePath) writeWorkspaceMcpServers(workspacePath, next);
  else throw new Error("工作区 MCP 操作缺少工作区路径");
  return saved;
}

export function deleteScopedMcpServer(scope: ResourceScope, id: string, workspacePath?: string): void {
  const servers = listScopedMcpServers(scope, workspacePath);
  const normalizedId = id.trim();
  if (!servers.some((server) => server.id === normalizedId)) throw new Error("MCP 服务器不存在");
  const next = servers.filter((server) => server.id !== normalizedId);
  if (scope === "platform") store.saveSettings({ ...store.settings, mcpServers: next });
  else if (workspacePath) writeWorkspaceMcpServers(workspacePath, next);
  else throw new Error("工作区 MCP 操作缺少工作区路径");
}

function resolveWorkspaceCwd(workspacePath: string, cwd: string | undefined): string {
  const root = fs.realpathSync(workspacePath);
  const target = path.resolve(root, cwd || ".");
  const relative = path.relative(root, target);
  if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
    throw new Error("工作区 MCP 的工作目录不能超出当前工作区");
  }
  return target;
}

function sdkConfig(server: McpServerConfig, workspacePath: string): MCPServerConfig {
  if (server.type === "local") {
    return {
      type: "stdio",
      command: server.command ?? "",
      args: server.args,
      env: server.env,
      workingDirectory: resolveWorkspaceCwd(workspacePath, server.cwd),
      tools: server.tools,
      timeout: server.timeout,
    };
  }
  return {
    type: "http",
    url: server.url ?? "",
    headers: server.headers,
    tools: server.tools,
    timeout: server.timeout,
  };
}

export function effectiveMcpServers(workspacePath: string): Record<string, MCPServerConfig> {
  const combined = new Map<string, { server: McpServerConfig; workspace: boolean }>();
  for (const server of listScopedMcpServers("platform")) {
    if (server.enabled) combined.set(server.id, { server, workspace: false });
  }
  for (const server of listScopedMcpServers("workspace", workspacePath)) {
    if (server.enabled) combined.set(server.id, { server, workspace: true });
    else combined.delete(server.id);
  }
  return Object.fromEntries([...combined].map(([id, value]) => [
    id,
    sdkConfig(value.server, workspacePath),
  ]));
}

export function redactMcpServer(server: McpServerConfig): McpServerConfig {
  const redact = (values: Record<string, string> | undefined) =>
    values ? Object.fromEntries(Object.keys(values).map((key) => [key, "******"])) : values;
  return { ...server, env: redact(server.env), headers: redact(server.headers) };
}
