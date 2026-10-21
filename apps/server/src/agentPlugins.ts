import fs from "node:fs";
import path from "node:path";
import type {
  AgentPluginManifest,
  AgentPluginMcpServer,
  AgentPluginRecord,
  AgentPluginScanResult,
  AgentPluginSkill,
} from "@cca/protocol";

// Agent Plugins 1.0 (https://agent-plugins.org/) loader.
// Pure filesystem functions: every failure is isolated to the plugin / skill /
// mcp server entry it belongs to and reported on that record instead of thrown.

const PLUGIN_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const SKILL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const MCP_SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const PLUGIN_SCHEMA_PREFIX = "https://agent-plugins.org/schemas/";
const MANIFEST_FIELDS = new Set([
  "$schema",
  "name",
  "version",
  "description",
  "author",
  "license",
  "keywords",
  "homepage",
]);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function byName(a: { name: string }, b: { name: string }): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' || first === "'") && last === first) return value.slice(1, -1);
  }
  return value;
}

/**
 * Parses a SKILL.md file: optional YAML frontmatter (`key: value` lines only,
 * no YAML dependency) delimited by `---`, followed by a non-empty markdown body.
 */
export function parseSkillMarkdown(text: string): {
  name?: string;
  description?: string;
  body: string;
  error?: string;
} {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  let name: string | undefined;
  let description: string | undefined;
  let body: string;

  if ((lines[0] ?? "").trim() === "---") {
    const fields = new Map<string, string>();
    let cursor = 1;
    let closed = false;
    for (; cursor < lines.length; cursor += 1) {
      const line = lines[cursor] ?? "";
      if (line.trim() === "---") {
        closed = true;
        cursor += 1;
        break;
      }
      const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (match) fields.set(match[1] ?? "", unquote((match[2] ?? "").trim()));
    }
    if (!closed) {
      return { body: "", error: "invalid skill frontmatter: missing closing ---" };
    }
    name = fields.get("name") || undefined;
    description = fields.get("description") || undefined;
    body = lines.slice(cursor).join("\n");
  } else {
    body = lines.join("\n");
  }

  if (!name) return { name, description, body, error: "missing skill name" };
  if (!description) return { name, description, body, error: "missing skill description" };
  if (body.trim() === "") return { name, description, body, error: "empty skill body" };
  return { name, description, body };
}

function loadSkill(skillDir: string, id: string): AgentPluginSkill {
  const skillPath = path.join(skillDir, "SKILL.md");
  const skill: AgentPluginSkill = { id, name: "", description: "", path: skillPath, valid: true };
  if (!SKILL_ID_PATTERN.test(id)) {
    skill.valid = false;
    skill.error = `invalid skill id "${id}": must match ^[a-z0-9][a-z0-9._-]*$`;
    return skill;
  }

  let text: string;
  try {
    text = fs.readFileSync(skillPath, "utf8");
  } catch (error) {
    skill.valid = false;
    skill.error =
      (error as NodeJS.ErrnoException).code === "ENOENT"
        ? "missing SKILL.md"
        : `failed to read SKILL.md: ${errorMessage(error)}`;
    return skill;
  }

  const parsed = parseSkillMarkdown(text);
  skill.name = parsed.name ?? "";
  skill.description = parsed.description ?? "";
  if (parsed.error) {
    skill.valid = false;
    skill.error = parsed.error;
  }
  return skill;
}

function scanPluginSkills(pluginPath: string): AgentPluginSkill[] {
  const skillsDir = path.join(pluginPath, "skills");
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .sort(byName)
    .map((entry) => loadSkill(path.join(skillsDir, entry.name), entry.name));
}

function parseMcpServer(name: string, value: unknown): AgentPluginMcpServer {
  const server: AgentPluginMcpServer = { name, transport: "stdio", valid: true };
  if (!isPlainObject(value)) {
    server.valid = false;
    server.error = `server "${name}": entry must be a JSON object`;
    return server;
  }

  const problems: string[] = [];
  const command = value.command;
  const url = value.url;
  const args = value.args;
  const env = value.env;
  const cwd = value.cwd;
  const headers = value.headers;

  const hasCommand = typeof command === "string" && command !== "";
  const hasUrl = typeof url === "string" && url !== "";
  if (command !== undefined && !hasCommand) {
    problems.push(`server "${name}": command must be a non-empty string`);
  }
  if (url !== undefined && !hasUrl) {
    problems.push(`server "${name}": url must be a non-empty string`);
  }
  if (hasCommand && hasUrl) {
    problems.push(`server "${name}": command and url are mutually exclusive`);
  } else if (!hasCommand && !hasUrl && problems.length === 0) {
    problems.push(`server "${name}": either command or url is required`);
  }

  const argsOk = Array.isArray(args) && args.every((item) => typeof item === "string");
  if (args !== undefined && !argsOk) {
    problems.push(`server "${name}": args must be an array of strings`);
  }
  const envOk = isPlainObject(env) && Object.values(env).every((item) => typeof item === "string");
  if (env !== undefined && !envOk) {
    problems.push(`server "${name}": env values must be strings`);
  }
  if (cwd !== undefined && typeof cwd !== "string") {
    problems.push(`server "${name}": cwd must be a string`);
  }
  const headersOk =
    isPlainObject(headers) && Object.values(headers).every((item) => typeof item === "string");
  if (headers !== undefined && !headersOk) {
    problems.push(`server "${name}": headers values must be strings`);
  }

  if (hasCommand) {
    server.transport = "stdio";
    server.command = command;
    if (cwd !== undefined && typeof cwd === "string") server.cwd = cwd;
  } else if (hasUrl) {
    server.transport = "streamable-http";
    server.url = url;
  }
  if (argsOk) server.args = [...(args as string[])];
  if (envOk) server.env = { ...(env as Record<string, string>) };
  if (headersOk) server.headers = { ...(headers as Record<string, string>) };

  if (problems.length > 0) {
    server.valid = false;
    server.error = problems.join("; ");
  }
  return server;
}

function scanPluginMcpServers(pluginPath: string, errors: string[]): AgentPluginMcpServer[] {
  const file = path.join(pluginPath, "mcp.json");
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      errors.push(`failed to read mcp.json: ${errorMessage(error)}`);
    }
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    errors.push(`invalid mcp.json: ${errorMessage(error)}`);
    return [];
  }
  if (!isPlainObject(parsed)) {
    errors.push("invalid mcp.json: expected a JSON object");
    return [];
  }
  const servers = parsed.servers;
  if (servers === undefined) return [];
  if (!isPlainObject(servers)) {
    errors.push('invalid mcp.json: "servers" must be a JSON object');
    return [];
  }

  return Object.entries(servers)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, value]) => {
      if (!MCP_SERVER_NAME_PATTERN.test(name)) {
        return {
          name,
          transport: "stdio" as const,
          valid: false,
          error: `invalid server name "${name}": must match ^[A-Za-z0-9_-]{1,32}$`,
        };
      }
      return parseMcpServer(name, value);
    });
}

interface LoadedPlugin {
  record: AgentPluginRecord;
  /** Valid-format manifest name; claims the name when present (first scan wins on duplicates). */
  claimedName?: string;
}

function loadPlugin(pluginPath: string, dirName: string): LoadedPlugin {
  const record: AgentPluginRecord = {
    id: dirName,
    path: pluginPath,
    manifest: { name: "" },
    skills: [],
    mcpServers: [],
    hasExtensions: isDirectory(path.join(pluginPath, "extensions")),
    warnings: [],
    errors: [],
    valid: false,
  };

  let manifestText: string;
  try {
    manifestText = fs.readFileSync(path.join(pluginPath, "plugin.json"), "utf8");
  } catch (error) {
    record.errors.push(
      (error as NodeJS.ErrnoException).code === "ENOENT"
        ? "missing plugin.json"
        : `failed to read plugin.json: ${errorMessage(error)}`,
    );
    return { record };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestText);
  } catch (error) {
    record.errors.push(`invalid plugin.json: ${errorMessage(error)}`);
    return { record };
  }
  if (!isPlainObject(parsed)) {
    record.errors.push("invalid plugin.json: expected a JSON object");
    return { record };
  }

  // Preserve every field (including unknown ones) but guarantee a string name.
  const rawName = parsed.name;
  record.manifest = {
    ...parsed,
    name: typeof rawName === "string" ? rawName : "",
  } as AgentPluginManifest;

  const schema = parsed.$schema;
  if (schema === undefined) {
    record.warnings.push("missing $schema");
  } else if (typeof schema !== "string" || !schema.startsWith(PLUGIN_SCHEMA_PREFIX)) {
    record.warnings.push(`$schema should be a URL starting with ${PLUGIN_SCHEMA_PREFIX}`);
  }

  const unknownFields = Object.keys(parsed)
    .filter((key) => !MANIFEST_FIELDS.has(key))
    .sort();
  if (unknownFields.length > 0) {
    record.warnings.push(`unknown manifest fields: ${unknownFields.join(", ")}`);
  }

  let claimedName: string | undefined;
  if (typeof rawName !== "string" || rawName === "") {
    record.errors.push("missing plugin name");
    record.id = dirName;
  } else if (rawName.length > 64 || !PLUGIN_NAME_PATTERN.test(rawName)) {
    record.errors.push(
      `invalid plugin name "${rawName}": must match ^[a-z0-9][a-z0-9._-]*$ and be 1-64 characters`,
    );
    record.id = rawName;
  } else {
    record.id = rawName;
    claimedName = rawName;
  }

  record.skills = scanPluginSkills(pluginPath);
  record.mcpServers = scanPluginMcpServers(pluginPath, record.errors);
  record.valid = record.errors.length === 0;
  return claimedName ? { record, claimedName } : { record };
}

function failedRecord(pluginPath: string, dirName: string, message: string): AgentPluginRecord {
  return {
    id: dirName,
    path: pluginPath,
    manifest: { name: "" },
    skills: [],
    mcpServers: [],
    hasExtensions: false,
    warnings: [],
    errors: [message],
    valid: false,
  };
}

function ensurePluginDataDir(dataRoot: string, pluginName: string, record: AgentPluginRecord): void {
  try {
    fs.mkdirSync(pluginDataDir(dataRoot, pluginName), { recursive: true });
  } catch (error) {
    record.warnings.push(`failed to create plugin data directory: ${errorMessage(error)}`);
  }
}

/**
 * Scans every first-level directory under pluginRoot (hidden directories are
 * skipped). Failures never throw: they are isolated to the plugin record.
 * Duplicate manifest names keep the first scanned plugin; later ones become
 * invalid with a "duplicate plugin name" error.
 */
export function scanAgentPlugins(pluginRoot: string, dataRoot: string): AgentPluginScanResult {
  const plugins: AgentPluginRecord[] = [];
  const claimedNames = new Set<string>();

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(pluginRoot, { withFileTypes: true });
  } catch {
    return { plugins, pluginRoot, dataRoot };
  }

  const directories = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .sort(byName);

  for (const entry of directories) {
    const pluginPath = path.join(pluginRoot, entry.name);
    let loaded: LoadedPlugin;
    try {
      loaded = loadPlugin(pluginPath, entry.name);
    } catch (error) {
      loaded = {
        record: failedRecord(pluginPath, entry.name, `failed to load plugin: ${errorMessage(error)}`),
      };
    }

    const record = loaded.record;
    if (loaded.claimedName) {
      if (claimedNames.has(loaded.claimedName)) {
        record.errors.push("duplicate plugin name");
      } else {
        claimedNames.add(loaded.claimedName);
      }
    }
    record.valid = record.errors.length === 0;
    if (loaded.claimedName) {
      ensurePluginDataDir(dataRoot, loaded.claimedName, record);
    }
    plugins.push(record);
  }

  return { plugins, pluginRoot, dataRoot };
}

/** Writable data directory for a plugin: <dataRoot>/<pluginName>. */
export function pluginDataDir(dataRoot: string, pluginName: string): string {
  return path.join(dataRoot, pluginName);
}

/** Runtime environment variables injected into a plugin's processes. */
export function pluginEnv(record: AgentPluginRecord, dataRoot: string): Record<string, string> {
  return {
    PLUGIN_ROOT: record.path,
    PLUGIN_DATA: pluginDataDir(dataRoot, record.id),
  };
}

/** skills/ directories of valid plugins that exist on disk, for the skill system to mount. */
export function collectPluginSkillDirs(result: AgentPluginScanResult): string[] {
  const dirs: string[] = [];
  for (const plugin of result.plugins) {
    if (!plugin.valid) continue;
    const dir = path.join(plugin.path, "skills");
    if (isDirectory(dir)) dirs.push(dir);
  }
  return dirs;
}

/** Valid MCP server entries for merging into the MCP configuration. */
export function collectPluginMcpServers(result: AgentPluginScanResult): AgentPluginMcpServer[] {
  return result.plugins.flatMap((plugin) => plugin.mcpServers.filter((server) => server.valid));
}
