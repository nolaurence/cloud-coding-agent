import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { MCPServerConfig } from "@github/copilot-sdk";
import type {
  InstalledPlugin,
  MarketplacePlugin,
  PluginAuthor,
  PluginConformance,
  PluginInstallResult,
  PluginMarketplace,
  PluginMcpServerInfo,
  PluginSkillInfo,
} from "@cca/protocol";
import { BUILTIN_CATALOG, BUILTIN_PLUGIN_PACKAGES, type CatalogPlugin } from "./agentPluginCatalog.js";
import { PLUGIN_DATA_DIR, PLUGINS_DIR, PLUGINS_STATE_FILE } from "./env.js";

const execFileAsync = promisify(execFile);

/**
 * Agent Plugins 1.0.0 客户端实现。
 *
 * 规范要点(https://agent-plugins.org/specification):
 * - 插件是一个目录,根上必须有 plugin.json,`$schema` 声明规范版本;
 * - 组件位置固定:skills/ 下每个含 SKILL.md 的直接子目录、根上 mcp.json;
 * - 所有被读取的包内路径解析后必须仍在插件根内;
 * - 未知顶层字段只报告不致命,其它清单违规整包拒绝;
 * - stdio MCP 子进程必须拿到 PLUGIN_ROOT / PLUGIN_DATA,并支持占位符展开。
 *
 * 对还没有 `$schema` 的生态仓库(Claude/Codex/Copilot 布局)走"兼容模式":
 * 仍然校验结构、组件路径与逃逸,但允许 skills / mcpServers 字段指向自定义
 * 路径,并在 UI 上标注。
 */

const MANIFEST_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const MCP_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";
const PLUGIN_NAME = /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;
const SKILL_NAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const MANIFEST_FIELDS = new Set([
  "$schema", "name", "version", "description", "author",
  "homepage", "repository", "license", "keywords", "extensions",
]);
const MANIFEST_PATHS = [
  "plugin.json",
  ".codex-plugin/plugin.json",
  ".claude-plugin/plugin.json",
  ".cursor-plugin/plugin.json",
];
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const GIT_TIMEOUT_MS = 180_000;
const FETCH_TIMEOUT_MS = 15_000;
const CATALOG_TTL_MS = 10 * 60_000;

interface PluginRecord {
  name: string;
  displayName?: string;
  source: string;
  subdirectory?: string;
  installedAt: number;
  enabled: boolean;
}

interface PluginSource {
  id: string;
  name: string;
  url: string;
  description?: string;
}

interface PluginState {
  version: 1;
  sources: PluginSource[];
  installed: PluginRecord[];
}

interface ParsedManifest {
  conformance: PluginConformance;
  name: string;
  displayName?: string;
  version?: string;
  description?: string;
  author?: PluginAuthor;
  homepage?: string;
  repository?: string;
  license?: string;
  keywords: string[];
  warnings: string[];
  manifestPath: string;
  manifestDir: string;
  compat?: {
    skillsPath?: string;
    mcpPath?: string;
    mcpInline?: Record<string, unknown>;
  };
}

interface ValidSkill extends PluginSkillInfo {
  directory: string;
}

interface PluginDiscovery {
  manifest: ParsedManifest;
  skills: ValidSkill[];
  skillDir?: string;
  mcpServers: PluginMcpServerInfo[];
  mcpConfigs: Record<string, MCPServerConfig>;
  warnings: string[];
}

/* ------------------------------------------------------------------ state */

function emptyState(): PluginState {
  return { version: 1, sources: [], installed: [] };
}

export function readPluginState(): PluginState {
  try {
    const raw = JSON.parse(fs.readFileSync(PLUGINS_STATE_FILE, "utf8")) as unknown;
    if (!isRecord(raw)) return emptyState();
    const sources = Array.isArray(raw.sources)
      ? raw.sources.filter(isRecord).flatMap<PluginSource>((entry) => (
        typeof entry.id === "string" && typeof entry.name === "string" && typeof entry.url === "string"
          ? [{ id: entry.id, name: entry.name, url: entry.url, ...(typeof entry.description === "string" ? { description: entry.description } : {}) }]
          : []
      ))
      : [];
    const installed = Array.isArray(raw.installed)
      ? raw.installed.filter(isRecord).flatMap<PluginRecord>((entry) => (
        typeof entry.name === "string" && typeof entry.source === "string"
          ? [{
            name: entry.name,
            source: entry.source,
            ...(typeof entry.displayName === "string" ? { displayName: entry.displayName } : {}),
            ...(typeof entry.subdirectory === "string" ? { subdirectory: entry.subdirectory } : {}),
            installedAt: typeof entry.installedAt === "number" ? entry.installedAt : Date.now(),
            enabled: entry.enabled !== false,
          }]
          : []
      ))
      : [];
    return { version: 1, sources, installed };
  } catch {
    return emptyState();
  }
}

function writePluginState(state: PluginState): void {
  fs.mkdirSync(path.dirname(PLUGINS_STATE_FILE), { recursive: true });
  const tmp = `${PLUGINS_STATE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, PLUGINS_STATE_FILE);
}

/* -------------------------------------------------------------- utilities */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === ""
    || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function assertInside(root: string, target: string, message: string): string {
  const resolvedRoot = fs.realpathSync(root);
  const resolvedTarget = fs.realpathSync(target);
  if (!isInside(resolvedRoot, resolvedTarget)) throw new Error(message);
  return resolvedTarget;
}

function readJsonFile(file: string, label: string): unknown {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`${label} 不存在`);
    throw new Error(`${label} 无法读取:${(error as Error).message}`);
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`${label} 不是合法 JSON:${(error as Error).message}`);
  }
}

function optionalString(record: Record<string, unknown>, key: string, label: string): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${label} 必须是字符串`);
  return value;
}

function parseAuthor(raw: Record<string, unknown>, strict: boolean): PluginAuthor | undefined {
  const value = raw.author;
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("author 必须是对象");
  const author: PluginAuthor = {};
  for (const key of Object.keys(value)) {
    if (!["name", "email", "url"].includes(key)) {
      if (strict) throw new Error(`author 不允许字段 ${key}`);
      continue;
    }
    const field = value[key];
    if (field === undefined) continue;
    if (typeof field !== "string") throw new Error(`author.${key} 必须是字符串`);
    author[key as keyof PluginAuthor] = field;
  }
  return author;
}

function parseKeywords(raw: Record<string, unknown>, strict: boolean): string[] {
  const value = raw.keywords;
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    if (strict) throw new Error("keywords 必须是字符串数组");
    return [];
  }
  return value as string[];
}

function compatSlug(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/[^a-z0-9]+$/, "")
    .slice(0, 64)
    .replace(/[^a-z0-9]+$/, "");
  if (!slug || !PLUGIN_NAME.test(slug)) throw new Error("插件 name 无法规整为合法标识(小写字母/数字/中划线/点)");
  return slug;
}

/* ------------------------------------------------------------- manifest */

function parseManifest(file: string, root: string): ParsedManifest {
  const absolute = fs.realpathSync(file);
  assertInside(root, absolute, "plugin.json 不能通过链接指向插件目录外");
  const raw = readJsonFile(absolute, "plugin.json");
  if (!isRecord(raw)) throw new Error("plugin.json 必须是 JSON 对象");
  const manifest = "$schema" in raw ? parseStrictManifest(raw, absolute, root) : parseCompatManifest(raw, absolute);
  return manifest;
}

function parseStrictManifest(raw: Record<string, unknown>, file: string, root: string): ParsedManifest {
  const warnings: string[] = [];
  for (const key of Object.keys(raw)) {
    if (!MANIFEST_FIELDS.has(key)) warnings.push(`未知字段 "${key}" 已忽略`);
  }
  const schema = raw.$schema;
  if (typeof schema !== "string") throw new Error("$schema 必须是字符串");
  if (schema !== MANIFEST_SCHEMA) {
    throw new Error(
      schema.includes("agent-plugins.org")
        ? `不支持的 Agent Plugins 版本:${schema}`
        : `未识别的清单 $schema:${schema}`,
    );
  }
  const name = raw.name;
  if (typeof name !== "string" || name.length < 1 || name.length > 64 || !PLUGIN_NAME.test(name)) {
    throw new Error("name 必须为 1-64 位小写字母/数字/中划线/点,以字母数字开头结尾,且不含 -- 或 ..");
  }
  const extensions = raw.extensions;
  if (extensions !== undefined) {
    if (!isRecord(extensions)) {
      warnings.push("extensions 不是对象,已忽略");
    } else {
      for (const [namespace, value] of Object.entries(extensions)) {
        if (!isRecord(value)) throw new Error(`extensions.${namespace} 必须是对象`);
      }
    }
  }
  return {
    conformance: "agent-plugins-1.0.0",
    name,
    version: optionalString(raw, "version", "version"),
    description: optionalString(raw, "description", "description"),
    author: parseAuthor(raw, true),
    homepage: optionalString(raw, "homepage", "homepage"),
    repository: optionalString(raw, "repository", "repository"),
    license: optionalString(raw, "license", "license"),
    keywords: parseKeywords(raw, true),
    warnings,
    manifestPath: file,
    manifestDir: path.dirname(file),
  };
}

function parseCompatManifest(raw: Record<string, unknown>, file: string): ParsedManifest {
  const name = raw.name;
  if (typeof name !== "string" || name.trim() === "") throw new Error("plugin.json 缺少 name");
  const warnings = ["未声明 $schema,按兼容模式加载(安装时会重新校验组件)"];
  const skills = raw.skills;
  const mcpServers = raw.mcpServers;
  const compat: NonNullable<ParsedManifest["compat"]> = {};
  if (typeof skills === "string" && skills.trim() !== "") compat.skillsPath = skills;
  else if (skills !== undefined && typeof skills !== "string") warnings.push("skills 字段不是字符串,已忽略");
  if (typeof mcpServers === "string" && mcpServers.trim() !== "") compat.mcpPath = mcpServers;
  else if (isRecord(mcpServers)) compat.mcpInline = mcpServers;
  return {
    conformance: "compat",
    name: compatSlug(name),
    displayName: name,
    version: typeof raw.version === "string" ? raw.version : undefined,
    description: typeof raw.description === "string" ? raw.description : undefined,
    author: parseAuthor(raw, false),
    homepage: typeof raw.homepage === "string" ? raw.homepage : undefined,
    repository: typeof raw.repository === "string" ? raw.repository : undefined,
    license: typeof raw.license === "string" ? raw.license : undefined,
    keywords: parseKeywords(raw, false),
    warnings,
    manifestPath: file,
    manifestDir: path.dirname(file),
    compat,
  };
}

function findManifest(root: string): string | undefined {
  for (const relative of MANIFEST_PATHS) {
    const candidate = path.join(root, relative);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // 继续找下一个布局
    }
  }
  return undefined;
}

/* ------------------------------------------------------------- discovery */

function parseFrontmatter(raw: string): { name?: string; description?: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const front = match[1] ?? "";
  return {
    name: front.match(/^name:\s*(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, ""),
    description: front.match(/^description:\s*(.*)$/m)?.[1]?.trim().replace(/^["']|["']$/g, ""),
  };
}

function discoverSkills(root: string, directory: string, warnings: string[]): { skills: ValidSkill[]; skillDir?: string } {
  let resolved: string;
  try {
    resolved = fs.realpathSync(directory);
  } catch {
    return { skills: [] };
  }
  if (!isInside(fs.realpathSync(root), resolved)) {
    warnings.push("技能目录指向插件目录外,已禁用技能组件");
    return { skills: [] };
  }
  if (!fs.statSync(resolved).isDirectory()) {
    warnings.push("skills 不是目录,已禁用技能组件");
    return { skills: [] };
  }
  const skills: ValidSkill[] = [];
  for (const entry of fs.readdirSync(resolved, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillDir = path.join(resolved, entry.name);
    const skillFile = path.join(skillDir, "SKILL.md");
    try {
      if (!fs.statSync(skillFile).isFile()) continue;
      const target = fs.realpathSync(skillFile);
      if (!isInside(fs.realpathSync(root), target)) {
        skills.push({ name: entry.name, description: "", path: entry.name, valid: false, directory: skillDir, error: "SKILL.md 指向插件目录外" });
        continue;
      }
      const front = parseFrontmatter(fs.readFileSync(target, "utf8"));
      const name = front.name || entry.name;
      const description = front.description ?? "";
      if (!SKILL_NAME.test(name)) {
        skills.push({ name: entry.name, description, path: entry.name, valid: false, directory: skillDir, error: "技能 name 必须是小写字母/数字/中划线" });
        continue;
      }
      if (!description) {
        skills.push({ name, description, path: entry.name, valid: false, directory: skillDir, error: "SKILL.md 缺少 description" });
        continue;
      }
      skills.push({ name, description, path: entry.name, valid: true, directory: skillDir });
    } catch {
      // 单个技能失败不影响其它技能
    }
  }
  return { skills, skillDir: resolved };
}

function expandPlaceholders(value: string, root: string, dataDir: string): string {
  return value.split("${PLUGIN_ROOT}").join(root).split("${PLUGIN_DATA}").join(dataDir);
}

function resolveCwd(value: unknown, root: string, dataDir: string): string {
  if (value === undefined) return root;
  if (typeof value !== "string" || value.trim() === "") throw new Error("cwd 必须是字符串");
  const expanded = expandPlaceholders(value, root, dataDir);
  const candidate = path.isAbsolute(expanded)
    ? path.resolve(expanded)
    : path.resolve(root, expanded.replace(/^\.\//, ""));
  const dataRooted = expanded.startsWith(dataDir) || value.startsWith("${PLUGIN_DATA}");
  const rootRooted = !dataRooted;
  const base = rootRooted ? fs.realpathSync(root) : fs.realpathSync(dataDir);
  const nearest = realpathNearest(candidate);
  if (!isInside(base, nearest)) throw new Error("cwd 超出插件目录");
  return candidate;
}

function realpathNearest(target: string): string {
  let current = target;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return fs.realpathSync(current);
}

function normalizeStdioCommand(value: unknown, root: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error("command 必须是非空字符串");
  const command = value.trim();
  if (!command.startsWith("./") && !command.startsWith(".\\")) {
    if (/[\\/]/.test(command) || command.includes(" ")) throw new Error("command 只能是可执行名或以 ./ 开头的插件内路径");
    return command;
  }
  const resolved = path.resolve(root, command);
  const nearest = realpathNearest(resolved);
  if (!isInside(fs.realpathSync(root), nearest)) throw new Error("command 超出插件目录");
  return resolved;
}

function parseHeaders(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("headers 必须是对象");
  const headers: Record<string, string> = {};
  const seen = new Set<string>();
  for (const [name, header] of Object.entries(value)) {
    if (typeof header !== "string") throw new Error(`headers.${name} 必须是字符串`);
    if (!HEADER_NAME.test(name)) throw new Error(`非法的请求头名称:${name}`);
    if (/[\r\n]/.test(header)) throw new Error(`请求头 ${name} 含有换行`);
    const lower = name.toLowerCase();
    if (seen.has(lower)) throw new Error(`请求头 ${name} 重复(名称大小写不敏感)`);
    seen.add(lower);
    headers[name] = header;
  }
  return headers;
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host === "::1" || /^127\./.test(host);
}

function normalizeUrl(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error("url 必须是非空字符串");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("url 不是合法地址");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHost(url.hostname))) {
    throw new Error("远程 MCP 必须使用 https(localhost/127.0.0.1 可用 http)");
  }
  if (url.username || url.password) throw new Error("url 不能包含用户信息");
  if (url.hash) throw new Error("url 不能包含片段");
  return url.toString();
}

function buildStdioConfig(
  command: unknown,
  args: unknown,
  env: unknown,
  cwd: unknown,
  root: string,
  dataDir: string,
  timeout?: number,
): MCPServerConfig {
  const resolvedCommand = normalizeStdioCommand(command, root);
  const expandedArgs = Array.isArray(args)
    ? args.map((arg) => {
      if (typeof arg !== "string") throw new Error("args 必须是字符串数组");
      return expandPlaceholders(arg, root, dataDir);
    })
    : [];
  const expandedEnv: Record<string, string> = {};
  if (env !== undefined) {
    if (!isRecord(env)) throw new Error("env 必须是字符串到字符串的对象");
    for (const [key, value] of Object.entries(env)) {
      if (key === "PLUGIN_ROOT" || key === "PLUGIN_DATA") throw new Error("env 不能覆盖 PLUGIN_ROOT / PLUGIN_DATA");
      if (typeof value !== "string") throw new Error(`env.${key} 必须是字符串`);
      expandedEnv[key] = expandPlaceholders(value, root, dataDir);
    }
  }
  return {
    type: "stdio",
    command: resolvedCommand,
    args: expandedArgs,
    env: { ...expandedEnv, PLUGIN_ROOT: root, PLUGIN_DATA: dataDir },
    workingDirectory: resolveCwd(cwd, root, dataDir),
    ...(timeout ? { timeout } : {}),
  };
}

function buildHttpConfig(url: unknown, headers: unknown, timeout?: number): MCPServerConfig {
  return {
    type: "http",
    url: normalizeUrl(url),
    ...(headers === undefined ? {} : { headers: parseHeaders(headers) }),
    ...(timeout ? { timeout } : {}),
  };
}

function serverLabel(config: MCPServerConfig): string {
  return "command" in config ? config.command : config.url;
}

function parseServer(
  id: string,
  raw: unknown,
  root: string,
  dataDir: string,
  conformance: PluginConformance,
): { info: PluginMcpServerInfo; config: MCPServerConfig } {
  if (!isRecord(raw)) throw new Error("服务器配置必须是对象");
  const type = raw.type;
  const compat = conformance === "compat";
  const timeout = typeof raw.timeout === "number" && raw.timeout > 0 ? raw.timeout : undefined;

  const known = new Set(["type", "command", "args", "env", "cwd", "url", "headers"]);
  if (compat) known.add("timeout");
  const isStdio = type === undefined ? "command" in raw : type === "stdio" || (compat && type === "local");
  const transport: PluginMcpServerInfo["transport"] = isStdio
    ? "stdio"
    : type === "sse"
      ? "sse"
      : "streamable-http";

  if (!compat) {
    for (const key of Object.keys(raw)) {
      if (!known.has(key)) throw new Error(`未知字段 ${key}`);
    }
    if (type === undefined) throw new Error("缺少 type");
    if (type !== "stdio" && type !== "streamable-http" && type !== "sse") throw new Error(`不支持的 type:${String(type)}`);
  }
  if (transport === "sse") throw new Error("当前运行时只支持 stdio 与 streamable-http,已跳过 sse 服务器");

  const config = transport === "stdio"
    ? buildStdioConfig(raw.command, raw.args, raw.env, raw.cwd, root, dataDir, timeout)
    : buildHttpConfig(raw.url, raw.headers, timeout);
  return {
    info: { id, transport, label: serverLabel(config), valid: true },
    config,
  };
}

function discoverMcp(
  root: string,
  manifest: ParsedManifest,
  dataDir: string,
  warnings: string[],
): { servers: PluginMcpServerInfo[]; configs: Record<string, MCPServerConfig> } {
  const strict = manifest.conformance === "agent-plugins-1.0.0";
  let raw: unknown;
  let sourceLabel = "mcp.json";

  if (manifest.compat?.mcpInline) {
    raw = { mcpServers: manifest.compat.mcpInline };
    sourceLabel = "plugin.json#mcpServers";
  } else {
    const relative = manifest.compat?.mcpPath
      ?? (strict
        ? "mcp.json"
        : (fs.existsSync(path.join(root, ".mcp.json")) ? ".mcp.json" : "mcp.json"));
    const file = path.resolve(root, relative);
    if (!isInside(root, realpathNearest(file)) || !fs.existsSync(file)) {
      if (manifest.compat?.mcpPath) warnings.push(`MCP 配置 ${relative} 不存在,已跳过 MCP 组件`);
      return { servers: [], configs: {} };
    }
    try {
      raw = readJsonFile(file, sourceLabel);
    } catch (error) {
      warnings.push(`MCP 配置无效:${(error as Error).message}`);
      return { servers: [], configs: {} };
    }
    sourceLabel = relative;
  }

  if (!isRecord(raw)) {
    warnings.push(`${sourceLabel} 必须是 JSON 对象,已跳过 MCP 组件`);
    return { servers: [], configs: {} };
  }
  if (strict) {
    const extra = Object.keys(raw).filter((key) => key !== "$schema" && key !== "mcpServers");
    if (extra.length > 0) {
      warnings.push(`${sourceLabel} 只允许 $schema 与 mcpServers,已跳过 MCP 组件`);
      return { servers: [], configs: {} };
    }
    if (raw.$schema !== MCP_SCHEMA) {
      warnings.push(`${sourceLabel} 的 $schema 与插件规范版本不一致,已跳过 MCP 组件`);
      return { servers: [], configs: {} };
    }
  }
  const servers = raw.mcpServers;
  if (!isRecord(servers)) {
    warnings.push(`${sourceLabel} 缺少 mcpServers 对象,已跳过 MCP 组件`);
    return { servers: [], configs: {} };
  }

  const infos: PluginMcpServerInfo[] = [];
  const configs: Record<string, MCPServerConfig> = {};
  for (const [id, server] of Object.entries(servers)) {
    try {
      const parsed = parseServer(id, server, root, dataDir, manifest.conformance);
      infos.push(parsed.info);
      configs[id] = parsed.config;
    } catch (error) {
      infos.push({
        id,
        transport: "stdio",
        label: id,
        valid: false,
        error: (error as Error).message,
      });
    }
  }
  return { servers: infos, configs };
}

const discoveryCache = new Map<string, { signature: string; discovery: PluginDiscovery }>();

function pluginSignature(root: string, manifestPath: string): string {
  try {
    const manifest = fs.statSync(manifestPath).mtimeMs;
    const skillsDir = path.join(root, "skills");
    const skills = fs.existsSync(skillsDir) ? fs.statSync(skillsDir).mtimeMs : 0;
    return `${manifest}:${skills}`;
  } catch {
    return String(Date.now());
  }
}

export function loadPlugin(root: string): PluginDiscovery {
  const manifestPath = findManifest(root);
  if (!manifestPath) throw new Error("未找到 plugin.json(已尝试根目录与 .codex-plugin/.claude-plugin/.cursor-plugin)");
  const manifest = parseManifest(manifestPath, root);
  const signature = `${manifest.conformance}:${manifestPath}:${pluginSignature(root, manifestPath)}`;
  const cached = discoveryCache.get(root);
  if (cached && cached.signature === signature) return cached.discovery;

  const dataDir = path.join(PLUGIN_DATA_DIR, manifest.name);
  const warnings = [...manifest.warnings];
  const skillsDir = manifest.compat?.skillsPath
    ? path.resolve(root, manifest.compat.skillsPath)
    : path.join(root, "skills");
  const { skills, skillDir } = discoverSkills(root, skillsDir, warnings);
  const mcp = discoverMcp(root, manifest, dataDir, warnings);
  const discovery: PluginDiscovery = {
    manifest,
    skills,
    ...(skillDir === undefined ? {} : { skillDir }),
    mcpServers: mcp.servers,
    mcpConfigs: mcp.configs,
    warnings,
  };
  discoveryCache.set(root, { signature, discovery });
  return discovery;
}

function recordRoot(record: PluginRecord): string {
  return path.join(PLUGINS_DIR, record.name);
}

function describePlugin(record: PluginRecord): InstalledPlugin {
  const base: InstalledPlugin = {
    name: record.name,
    ...(record.displayName === undefined ? {} : { displayName: record.displayName }),
    source: record.source,
    ...(record.subdirectory === undefined ? {} : { subdirectory: record.subdirectory }),
    installedAt: record.installedAt,
    enabled: record.enabled,
    conformance: "compat",
    keywords: [],
    skills: [],
    mcpServers: [],
    warnings: [],
  };
  const root = recordRoot(record);
  if (!fs.existsSync(root)) {
    return { ...base, error: "插件文件缺失,请重新安装" };
  }
  try {
    const discovery = loadPlugin(root);
    const manifest = discovery.manifest;
    return {
      ...base,
      ...(manifest.displayName === undefined ? {} : { displayName: manifest.displayName }),
      conformance: manifest.conformance,
      ...(manifest.version === undefined ? {} : { version: manifest.version }),
      ...(manifest.description === undefined ? {} : { description: manifest.description }),
      ...(manifest.author === undefined ? {} : { author: manifest.author }),
      ...(manifest.homepage === undefined ? {} : { homepage: manifest.homepage }),
      ...(manifest.repository === undefined ? {} : { repository: manifest.repository }),
      ...(manifest.license === undefined ? {} : { license: manifest.license }),
      keywords: manifest.keywords,
      skills: discovery.skills.map(({ directory: _directory, ...skill }) => skill),
      mcpServers: discovery.mcpServers,
      warnings: discovery.warnings,
    };
  } catch (error) {
    return { ...base, error: (error as Error).message };
  }
}

/* --------------------------------------------------------------- public */

export function listInstalledPlugins(): InstalledPlugin[] {
  return readPluginState().installed
    .map(describePlugin)
    .sort((left, right) => left.name.localeCompare(right.name));
}

/** 供技能模块复用:已启用且含有效技能的插件,暴露过滤后的技能视图目录。 */
export function pluginSkillDirectories(): string[] {
  const dirs: string[] = [];
  for (const record of readPluginState().installed) {
    if (!record.enabled) continue;
    const root = recordRoot(record);
    if (!fs.existsSync(root)) continue;
    let discovery: PluginDiscovery;
    try {
      discovery = loadPlugin(root);
    } catch {
      continue;
    }
    const valid = discovery.skills.filter((skill) => skill.valid);
    if (valid.length === 0) continue;
    dirs.push(materializeSkillView(record.name, valid.map((skill) => skill.directory), discovery.skillDir));
  }
  return dirs;
}

function materializeSkillView(name: string, directories: string[], fallback?: string): string {
  try {
    const view = path.join(PLUGIN_DATA_DIR, name, "skills");
    fs.mkdirSync(view, { recursive: true });
    const wanted = new Set(directories.map((directory) => path.basename(directory)));
    for (const entry of fs.readdirSync(view)) {
      if (!wanted.has(entry)) fs.rmSync(path.join(view, entry), { recursive: true, force: true });
    }
    for (const directory of directories) {
      const link = path.join(view, path.basename(directory));
      if (fs.existsSync(link)) continue;
      fs.symlinkSync(fs.realpathSync(directory), link, "junction");
    }
    return view;
  } catch {
    return fallback ?? path.dirname(directories[0] ?? "");
  }
}

/** 插件贡献的 MCP 服务器:键为 plugin-server,优先级低于用户配置。 */
export function pluginMcpServerConfigs(): Record<string, MCPServerConfig> {
  const configs: Record<string, MCPServerConfig> = {};
  for (const record of readPluginState().installed) {
    if (!record.enabled) continue;
    const root = recordRoot(record);
    if (!fs.existsSync(root)) continue;
    try {
      const discovery = loadPlugin(root);
      for (const [id, config] of Object.entries(discovery.mcpConfigs)) {
        configs[`${record.name}-${id}`] = config;
      }
    } catch {
      // 单个插件加载失败不影响其它插件
    }
  }
  return configs;
}

/* ------------------------------------------------------------- install */

let installQueue: Promise<unknown> = Promise.resolve();

function withInstallLock<T>(task: () => Promise<T>): Promise<T> {
  const next = installQueue.then(task, task);
  installQueue = next.catch(() => undefined);
  return next;
}

function builtinPackage(source: string) {
  if (!source.startsWith("builtin:")) return undefined;
  const id = source.slice("builtin:".length);
  return BUILTIN_PLUGIN_PACKAGES.find((entry) => entry.id === id);
}

function normalizeGitSource(source: string): string {
  if (/^(?:https?|git|ssh):\/\//i.test(source) || /^git@[^:]+:/.test(source)) return source;
  if (/^[\w.-]+\/[\w.-]+$/.test(source)) return `https://github.com/${source}`;
  if (/^(?:github\.com|gitlab\.com|gitee\.com)\//i.test(source)) return `https://${source}`;
  throw new Error("来源格式不正确:请填 git 地址、owner/repo 或本地目录");
}

async function git(args: string[], cwd?: string): Promise<void> {
  try {
    await execFileAsync("git", args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
  } catch (error) {
    const detail = typeof (error as { stderr?: unknown }).stderr === "string" && (error as { stderr: string }).stderr.trim()
      ? (error as { stderr: string }).stderr.trim().split("\n").slice(-2).join(" ")
      : (error as Error).message;
    throw new Error(`git ${args[0] ?? ""} 失败:${detail}`);
  }
}

function assertNoEscapingLinks(root: string): void {
  const resolvedRoot = fs.realpathSync(root);
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        const resolved = fs.realpathSync(target);
        if (!isInside(resolvedRoot, resolved)) throw new Error(`插件包含指向目录外的链接:${path.relative(root, target)}`);
        continue;
      }
      if (entry.isDirectory()) walk(target);
    }
  };
  walk(resolvedRoot);
}

function copyPluginTree(source: string, target: string): void {
  fs.cpSync(source, target, {
    recursive: true,
    dereference: true,
    filter: (entry) => path.basename(entry) !== ".git",
  });
}

function writeBuiltinFiles(files: Record<string, string>, target: string): void {
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(target, relative);
    if (!isInside(target, file)) throw new Error(`内置插件包含非法路径:${relative}`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, { encoding: "utf8", mode: 0o600 });
  }
}

function assertInstallableName(name: string, records: readonly PluginRecord[]): void {
  if (!PLUGIN_NAME.test(name)) throw new Error("插件名称不合法");
  if (records.some((record) => record.name === name)) throw new Error(`插件 ${name} 已安装,请先卸载`);
}

/**
 * 安装一个 Agent Plugin。
 * @param source builtin:<id>、git 地址、owner/repo 或本地目录
 * @param subdirectory 仓库内插件所在子目录
 */
export async function installPlugin(source: string, subdirectory?: string): Promise<PluginInstallResult> {
  const trimmed = source.trim();
  if (!trimmed) throw new Error("请填写插件来源");
  return withInstallLock(async () => {
    fs.mkdirSync(PLUGINS_DIR, { recursive: true });
    fs.mkdirSync(PLUGIN_DATA_DIR, { recursive: true });
    const state = readPluginState();
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "cca-plugin-"));
    const staged = path.join(PLUGINS_DIR, `.staging-${randomUUID()}`);
    try {
      const builtin = builtinPackage(trimmed);
      let sourceRoot: string;
      if (builtin) {
        sourceRoot = path.join(temp, "plugin");
        fs.mkdirSync(sourceRoot, { recursive: true });
        writeBuiltinFiles(builtin.files, sourceRoot);
      } else if (fs.existsSync(trimmed) && fs.statSync(trimmed).isDirectory()) {
        sourceRoot = fs.realpathSync(trimmed);
        if (isInside(fs.realpathSync(PLUGINS_DIR), sourceRoot)) throw new Error("不能从插件安装目录自身安装");
      } else {
        const url = normalizeGitSource(trimmed);
        const cloneDir = path.join(temp, "repo");
        await git(["clone", "--depth", "1", "--no-tags", url, cloneDir]);
        sourceRoot = cloneDir;
      }

      if (subdirectory) {
        const resolvedSource = fs.realpathSync(sourceRoot);
        const nested = path.resolve(resolvedSource, subdirectory);
        if (!isInside(resolvedSource, realpathNearest(nested))) throw new Error("子目录超出仓库范围");
        if (!fs.existsSync(nested)) throw new Error(`仓库中不存在子目录 ${subdirectory}`);
        sourceRoot = fs.realpathSync(nested);
      }

      const manifestPath = findManifest(sourceRoot);
      if (!manifestPath) throw new Error("未找到 plugin.json(支持根目录、.codex-plugin、.claude-plugin、.cursor-plugin)");
      const manifest = parseManifest(manifestPath, sourceRoot);
      assertInstallableName(manifest.name, state.installed);

      // 清单可能位于 .codex-plugin/ 之类的子目录,插件根是它上一级。
      const manifestDir = path.dirname(manifestPath);
      const pluginRoot = [".codex-plugin", ".claude-plugin", ".cursor-plugin"].includes(path.basename(manifestDir))
        ? path.dirname(manifestDir)
        : manifestDir;
      assertNoEscapingLinks(pluginRoot);
      copyPluginTree(pluginRoot, staged);

      const target = path.join(PLUGINS_DIR, manifest.name);
      if (fs.existsSync(target)) throw new Error(`目录 ${manifest.name} 已存在,请先卸载`);
      fs.renameSync(staged, target);
      const dataDir = path.join(PLUGIN_DATA_DIR, manifest.name);
      fs.mkdirSync(dataDir, { recursive: true });

      const record: PluginRecord = {
        name: manifest.name,
        ...(manifest.displayName === undefined ? {} : { displayName: manifest.displayName }),
        source: trimmed,
        ...(subdirectory === undefined || subdirectory === "" ? {} : { subdirectory }),
        installedAt: Date.now(),
        enabled: true,
      };
      const described = describePlugin(record);
      if (described.error) {
        fs.rmSync(target, { recursive: true, force: true });
        fs.rmSync(dataDir, { recursive: true, force: true });
        throw new Error(`安装失败:${described.error}`);
      }

      writePluginState({ ...state, installed: [...state.installed, record] });
      discoveryCache.delete(target);
      return {
        plugin: described,
        skillsInstalled: described.skills.filter((skill) => skill.valid).length,
        warnings: described.warnings,
      };
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
      fs.rmSync(staged, { recursive: true, force: true });
    }
  });
}

export function uninstallPlugin(name: string): void {
  const state = readPluginState();
  const record = state.installed.find((entry) => entry.name === name);
  if (!record) throw new Error(`插件 ${name} 未安装`);
  fs.rmSync(recordRoot(record), { recursive: true, force: true });
  fs.rmSync(path.join(PLUGIN_DATA_DIR, record.name), { recursive: true, force: true });
  discoveryCache.delete(recordRoot(record));
  writePluginState({ ...state, installed: state.installed.filter((entry) => entry.name !== name) });
}

export function setPluginEnabled(name: string, enabled: boolean): void {
  const state = readPluginState();
  const record = state.installed.find((entry) => entry.name === name);
  if (!record) throw new Error(`插件 ${name} 未安装`);
  writePluginState({
    ...state,
    installed: state.installed.map((entry) => (entry.name === name ? { ...entry, enabled } : entry)),
  });
}

/* ------------------------------------------------------------- catalog */

interface RemoteCatalog {
  name?: string;
  description?: string;
  plugins?: unknown;
}

interface CatalogCacheEntry {
  at: number;
  plugins: CatalogPlugin[];
}

const remoteCatalogCache = new Map<string, CatalogCacheEntry>();

function sourceId(url: string): string {
  return `src-${createHash("sha1").update(url).digest("hex").slice(0, 12)}`;
}

function normalizeCatalogPlugin(raw: unknown, marketplaceId: string): MarketplacePlugin | undefined {
  if (!isRecord(raw)) return undefined;
  if (typeof raw.name !== "string" || raw.name.trim() === "") return undefined;
  if (typeof raw.source !== "string" || raw.source.trim() === "") return undefined;
  const tags = Array.isArray(raw.tags) ? raw.tags.filter((tag): tag is string => typeof tag === "string") : [];
  const name = raw.name.trim();
  return {
    id: `${marketplaceId}/${name}`,
    marketplaceId,
    name,
    description: typeof raw.description === "string" ? raw.description : "",
    source: raw.source.trim(),
    ...(typeof raw.subdirectory === "string" && raw.subdirectory.trim() !== "" ? { subdirectory: raw.subdirectory.trim() } : {}),
    ...(typeof raw.version === "string" ? { version: raw.version } : {}),
    ...(typeof raw.author === "string" ? { author: raw.author } : {}),
    ...(typeof raw.homepage === "string" ? { homepage: raw.homepage } : {}),
    ...(typeof raw.license === "string" ? { license: raw.license } : {}),
    tags,
    category: typeof raw.category === "string" && raw.category.trim() !== "" ? raw.category.trim() : "其他",
  };
}

function installedKeys(): { names: Set<string>; sources: Set<string> } {
  const state = readPluginState();
  return {
    names: new Set(state.installed.map((record) => record.name)),
    sources: new Set(state.installed.map((record) => `${record.source}|${record.subdirectory ?? ""}`)),
  };
}

function markInstalled(plugin: MarketplacePlugin): MarketplacePlugin {
  const { names, sources } = installedKeys();
  return {
    ...plugin,
    installed: names.has(plugin.name) || sources.has(`${plugin.source}|${plugin.subdirectory ?? ""}`),
  };
}

function builtinMarketplacePlugins(): MarketplacePlugin[] {
  const keys = installedKeys();
  return BUILTIN_CATALOG.plugins.map((entry) => ({
    id: entry.id,
    marketplaceId: BUILTIN_CATALOG.id,
    name: entry.name,
    description: entry.description,
    source: entry.source,
    ...(entry.subdirectory === undefined ? {} : { subdirectory: entry.subdirectory }),
    ...(entry.version === undefined ? {} : { version: entry.version }),
    ...(entry.author === undefined ? {} : { author: entry.author }),
    ...(entry.homepage === undefined ? {} : { homepage: entry.homepage }),
    ...(entry.license === undefined ? {} : { license: entry.license }),
    tags: entry.tags,
    category: entry.category,
    installed: keys.names.has(entry.name) || keys.sources.has(`${entry.source}|${entry.subdirectory ?? ""}`),
  }));
}

async function fetchRemoteCatalog(source: PluginSource): Promise<CatalogPlugin[]> {
  const cached = remoteCatalogCache.get(source.id);
  if (cached && Date.now() - cached.at < CATALOG_TTL_MS) return cached.plugins;
  let response: Response;
  try {
    response = await fetch(source.url, {
      headers: { accept: "application/json", "user-agent": "cloud-coding-agent" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(`无法访问市场 ${source.name}:${(error as Error).message}`);
  }
  if (!response.ok) throw new Error(`市场 ${source.name} 返回 ${response.status}`);
  const body = await response.json().catch(() => undefined) as unknown;
  const rawPlugins = Array.isArray(body) ? body : isRecord(body) ? (body as RemoteCatalog).plugins : undefined;
  if (!Array.isArray(rawPlugins)) throw new Error("市场清单缺少 plugins 数组");
  const plugins = rawPlugins.flatMap<CatalogPlugin>((raw) => {
    if (!isRecord(raw) || typeof raw.name !== "string" || typeof raw.source !== "string") return [];
    return [{
      id: raw.name,
      name: raw.name,
      description: typeof raw.description === "string" ? raw.description : "",
      source: raw.source,
      ...(typeof raw.subdirectory === "string" ? { subdirectory: raw.subdirectory } : {}),
      ...(typeof raw.version === "string" ? { version: raw.version } : {}),
      ...(typeof raw.author === "string" ? { author: raw.author } : {}),
      ...(typeof raw.homepage === "string" ? { homepage: raw.homepage } : {}),
      ...(typeof raw.license === "string" ? { license: raw.license } : {}),
      tags: Array.isArray(raw.tags) ? raw.tags.filter((tag): tag is string => typeof tag === "string") : [],
      category: typeof raw.category === "string" ? raw.category : "其他",
    }];
  });
  remoteCatalogCache.set(source.id, { at: Date.now(), plugins });
  return plugins;
}

export function listPluginMarketplaces(): PluginMarketplace[] {
  const state = readPluginState();
  return [
    {
      id: BUILTIN_CATALOG.id,
      name: BUILTIN_CATALOG.name,
      description: BUILTIN_CATALOG.description,
      source: "builtin",
      kind: "builtin",
      pluginCount: BUILTIN_CATALOG.plugins.length,
    },
    ...state.sources.map((source) => ({
      id: source.id,
      name: source.name,
      ...(source.description === undefined ? {} : { description: source.description }),
      source: source.url,
      kind: "remote" as const,
      pluginCount: remoteCatalogCache.get(source.id)?.plugins.length ?? 0,
    })),
  ];
}

export async function browsePluginMarketplace(marketplaceId: string): Promise<MarketplacePlugin[]> {
  if (marketplaceId === BUILTIN_CATALOG.id) return builtinMarketplacePlugins();
  const source = readPluginState().sources.find((entry) => entry.id === marketplaceId);
  if (!source) throw new Error("市场不存在");
  const plugins = await fetchRemoteCatalog(source);
  return plugins
    .map((entry) => normalizeCatalogPlugin(entry, source.id))
    .filter((entry): entry is MarketplacePlugin => entry !== undefined)
    .map(markInstalled);
}

export async function addPluginMarketplace(source: string): Promise<PluginMarketplace> {
  const url = source.trim();
  if (!/^https?:\/\//i.test(url)) throw new Error("市场地址必须是 http(s) JSON 地址");
  const state = readPluginState();
  const existing = state.sources.find((entry) => entry.url === url);
  if (existing) {
    return {
      id: existing.id,
      name: existing.name,
      source: existing.url,
      kind: "remote",
      pluginCount: 0,
    };
  }
  const id = sourceId(url);
  let name = new URL(url).hostname;
  let description: string | undefined;
  try {
    const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`返回 ${response.status}`);
    const body = await response.json() as unknown;
    if (isRecord(body)) {
      if (typeof body.name === "string" && body.name.trim() !== "") name = body.name.trim();
      if (typeof body.description === "string") description = body.description;
    }
  } catch (error) {
    throw new Error(`市场清单不可用:${(error as Error).message}`);
  }
  const entry: PluginSource = { id, name, url, ...(description === undefined ? {} : { description }) };
  writePluginState({ ...state, sources: [...state.sources, entry] });
  return { id, name, source: url, kind: "remote", pluginCount: 0, ...(description === undefined ? {} : { description }) };
}

export function removePluginMarketplace(marketplaceId: string): void {
  if (marketplaceId === BUILTIN_CATALOG.id) throw new Error("内置市场不能移除");
  const state = readPluginState();
  if (!state.sources.some((entry) => entry.id === marketplaceId)) throw new Error("市场不存在");
  remoteCatalogCache.delete(marketplaceId);
  writePluginState({ ...state, sources: state.sources.filter((entry) => entry.id !== marketplaceId) });
}
