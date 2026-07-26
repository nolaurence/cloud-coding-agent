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
export const SECRET_FILE = path.join(root, "secret.key");
export const SKILLS_DIR = path.join(root, "skills");
export const COPILOT_HOME = path.join(root, "copilot-home");
export const WORKSPACES_DIR = path.join(root, "workspaces");
export const UPLOADS_DIR = path.join(root, "uploads");

export function ensureDataDirs() {
  for (const dir of [root, SKILLS_DIR, COPILOT_HOME, WORKSPACES_DIR, UPLOADS_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
