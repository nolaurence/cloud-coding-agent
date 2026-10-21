// Agent Plugins 1.0 (https://agent-plugins.org/) shared types.
// A plugin is a directory: plugin.json (required) + optional skills/, mcp.json, extensions/.
// This module is the single source of truth for both server and web.

export interface AgentPluginManifest {
  /** Declares the spec version; must start with https://agent-plugins.org/schemas/ when present. */
  $schema?: string;
  /** Unique plugin identifier: ^[a-z0-9][a-z0-9._-]*$, 1-64 chars. */
  name: string;
  version?: string;
  description?: string;
  author?: string | { name: string; url?: string };
  license?: string;
  keywords?: string[];
  homepage?: string;
  /** Unknown fields are preserved for forward compatibility. */
  [key: string]: unknown;
}

export interface AgentPluginSkill {
  /** Directory name under skills/. */
  id: string;
  /** frontmatter.name */
  name: string;
  /** frontmatter.description */
  description: string;
  /** Absolute path of SKILL.md. */
  path: string;
  valid: boolean;
  error?: string;
}

export interface AgentPluginMcpServer {
  name: string;
  transport: "stdio" | "streamable-http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  valid: boolean;
  error?: string;
}

export interface AgentPluginRecord {
  /** manifest.name (the unique plugin id). */
  id: string;
  /** Absolute path of the plugin root directory. */
  path: string;
  manifest: AgentPluginManifest;
  skills: AgentPluginSkill[];
  mcpServers: AgentPluginMcpServer[];
  /** Whether extensions/ exists (client specific; ignored by loaders that do not know it). */
  hasExtensions: boolean;
  /** Non-fatal issues, e.g. missing $schema or unknown top-level fields. */
  warnings: string[];
  /** Fatal issues, e.g. unparseable plugin.json or an invalid name. */
  errors: string[];
  valid: boolean;
}

export interface AgentPluginScanResult {
  /** Includes invalid plugins so the UI can render their errors. */
  plugins: AgentPluginRecord[];
  /** The scanned plugin root (the PLUGIN_ROOT base). */
  pluginRoot: string;
  /** Base directory for per-plugin writable data (the PLUGIN_DATA base). */
  dataRoot: string;
}
