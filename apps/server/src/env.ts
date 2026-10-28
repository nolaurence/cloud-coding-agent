import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const root = process.env.CCA_DATA_DIR
  ? path.resolve(process.env.CCA_DATA_DIR)
  : path.join(os.homedir(), ".cloud-coding-agent");

export const DATA_DIR = root;
export const SETTINGS_FILE = path.join(root, "settings.json");
export const PROJECTS_FILE = path.join(root, "projects.json");
export const THREADS_FILE = path.join(root, "threads.json");
export const USERS_FILE = path.join(root, "users.json");
export const REGISTRATION_FILE = path.join(root, "registration.json");
export const THREAD_SHARES_FILE = path.join(root, "thread-shares.json");
export const GIT_BINDINGS_FILE = path.join(root, "git-bindings.json");
export const SECRET_FILE = path.join(root, "secret.key");
export const SKILLS_DIR = path.join(root, "skills");
/** Agent Plugins 安装目录(每个插件一个子目录)。 */
export const PLUGINS_DIR = path.join(root, "agent-plugins");
/** 每个插件实例的私有持久化目录,挂载为 PLUGIN_DATA。 */
export const PLUGIN_DATA_DIR = path.join(root, "agent-plugin-data");
/** 插件安装记录与自定义市场源。 */
export const PLUGINS_STATE_FILE = path.join(root, "agent-plugins.json");
export const COPILOT_HOME = path.join(root, "copilot-home");
export const WORKSPACE_ROOT = path.resolve(
  process.env.WORKSPACE_ROOT?.trim() ||
    (process.env.CCA_LOCAL_MODE === "true" || process.env.LOCAL_MODE === "true"
      ? path.join(root, "workspaces")
      : "/workspace"),
);
export const UPLOADS_DIR = path.join(root, "uploads");

/** Desktop and standalone local builds opt out of account management. */
export function isLocalMode(): boolean {
  return process.env.CCA_LOCAL_MODE === "true" || process.env.LOCAL_MODE === "true";
}

export function ensureDataDirs() {
  for (const dir of [root, SKILLS_DIR, PLUGINS_DIR, PLUGIN_DATA_DIR, COPILOT_HOME, WORKSPACE_ROOT, UPLOADS_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
