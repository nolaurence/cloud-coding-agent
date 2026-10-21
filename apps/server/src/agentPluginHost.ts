// Agent Plugins 1.0 标准的应用层装配：插件目录扫描、安装/卸载/启停、
// 并把启用插件的 skills 与 mcp.json 导出为会话运行时配置（DeepSeek Harness / 技能系统共用）。
//
// 目录约定：
//   <DATA_DIR>/plugins/<plugin>/plugin.json   已安装插件（Agent Plugins 标准目录结构）
//   <DATA_DIR>/plugin-data/<plugin>/          插件可写数据目录（标准的 PLUGIN_DATA）
import fs from "node:fs";
import path from "node:path";
import type {
  AgentPluginRecord,
  AgentPluginScanResult,
  InstalledPlugin,
  MCPServerConfig,
  PluginInstallResult,
} from "@cca/protocol";
import {
  collectPluginMcpServers,
  collectPluginSkillDirs,
  scanAgentPlugins,
} from "./agentPlugins.js";
import { DATA_DIR } from "./env.js";
import { store } from "./store.js";

export const AGENT_PLUGINS_ROOT = path.join(DATA_DIR, "plugins");
export const AGENT_PLUGIN_DATA_ROOT = path.join(DATA_DIR, "plugin-data");

function disabledNames(): Set<string> {
  return new Set(store.settings.disabledAgentPlugins ?? []);
}

function toInstalled(record: AgentPluginRecord, disabled: Set<string>): InstalledPlugin {
  return {
    name: record.id,
    path: record.path,
    ...(record.manifest.version ? { version: record.manifest.version } : {}),
    ...(record.manifest.description ? { description: record.manifest.description } : {}),
    enabled: !disabled.has(record.id),
    record,
  };
}

export function scanInstalledPlugins(): InstalledPlugin[] {
  fs.mkdirSync(AGENT_PLUGINS_ROOT, { recursive: true });
  const result = scanAgentPlugins(AGENT_PLUGINS_ROOT, AGENT_PLUGIN_DATA_ROOT);
  const disabled = disabledNames();
  return result.plugins.map((record) => toInstalled(record, disabled));
}

export interface AgentPluginRuntimeConfig {
  /** 启用插件的技能根目录（<plugin>/skills），供技能系统与 Harness 运行时挂载。 */
  skillDirs: string[];
  /** 启用插件的 mcp.json 条目，转换为会话 MCP 配置（SDK 形状）。 */
  mcpServers: Record<string, MCPServerConfig>;
}

export function agentPluginRuntimeConfig(): AgentPluginRuntimeConfig {
  const result = scanAgentPlugins(AGENT_PLUGINS_ROOT, AGENT_PLUGIN_DATA_ROOT);
  const disabled = disabledNames();
  const enabled = result.plugins.filter((record) => record.valid && !disabled.has(record.id));
  const skillDirs = collectPluginSkillDirs({ ...result, plugins: enabled } satisfies AgentPluginScanResult);
  const mcpServers: Record<string, MCPServerConfig> = {};
  for (const server of collectPluginMcpServers({ ...result, plugins: enabled } satisfies AgentPluginScanResult)) {
    if (!server.valid) continue;
    if (server.transport === "stdio" && server.command) {
      mcpServers[server.name] = {
        type: "stdio",
        command: server.command,
        args: server.args ?? [],
        env: server.env ?? {},
        ...(server.cwd ? { workingDirectory: server.cwd } : {}),
        tools: "*",
      };
    } else if (server.transport === "streamable-http" && server.url) {
      mcpServers[server.name] = {
        type: "http",
        url: server.url,
        headers: server.headers ?? {},
        tools: "*",
      };
    }
  }
  return { skillDirs, mcpServers };
}

function assertInsidePluginsRoot(target: string) {
  const relative = path.relative(AGENT_PLUGINS_ROOT, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("插件路径不在插件根目录内");
  }
}

/** 从服务端目录安装插件：复制进插件根目录后重新扫描校验；无效则回滚。 */
export function installAgentPlugin(source: string): PluginInstallResult {
  const from = path.resolve(source);
  if (!fs.existsSync(path.join(from, "plugin.json"))) {
    throw new Error("所选目录缺少 plugin.json，不是 Agent Plugins 标准插件");
  }
  fs.mkdirSync(AGENT_PLUGINS_ROOT, { recursive: true });
  const target = path.join(AGENT_PLUGINS_ROOT, path.basename(from));
  assertInsidePluginsRoot(target);
  fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync(from, target, { recursive: true });
  const installed = scanInstalledPlugins().find((plugin) => path.resolve(plugin.path) === target);
  if (!installed) {
    fs.rmSync(target, { recursive: true, force: true });
    throw new Error("插件安装后无法识别，请检查 plugin.json");
  }
  if (!installed.record.valid) {
    fs.rmSync(target, { recursive: true, force: true });
    throw new Error("插件无效：" + installed.record.errors.join("；"));
  }
  const skillsInstalled = installed.record.skills.filter((skill) => skill.valid).length;
  return {
    plugin: installed,
    skillsInstalled,
    ...(installed.record.warnings.length
      ? { postInstallMessage: "警告：" + installed.record.warnings.join("；") }
      : {}),
  };
}

export function uninstallAgentPlugin(name: string): void {
  const plugin = scanInstalledPlugins().find((candidate) => candidate.name === name);
  if (!plugin) throw new Error("插件不存在：" + name);
  assertInsidePluginsRoot(path.resolve(plugin.path));
  fs.rmSync(plugin.path, { recursive: true, force: true });
  const disabled = (store.settings.disabledAgentPlugins ?? []).filter((entry) => entry !== name);
  if (disabled.length !== (store.settings.disabledAgentPlugins ?? []).length) {
    store.saveSettings({ ...store.settings, disabledAgentPlugins: disabled });
  }
}

export function setAgentPluginEnabled(name: string, enabled: boolean): void {
  const plugin = scanInstalledPlugins().find((candidate) => candidate.name === name);
  if (!plugin) throw new Error("插件不存在：" + name);
  const disabled = new Set(store.settings.disabledAgentPlugins ?? []);
  if (enabled) disabled.delete(name);
  else disabled.add(name);
  store.saveSettings({ ...store.settings, disabledAgentPlugins: [...disabled] });
}
