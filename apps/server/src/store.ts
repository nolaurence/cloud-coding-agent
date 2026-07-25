import fs from "node:fs";
import {
  AppSettings,
  DEFAULT_SETTINGS,
  Project,
  ThreadMeta,
} from "@cca/protocol";
import { PROJECTS_FILE, SETTINGS_FILE, THREADS_FILE } from "./env.js";

function readJson<T>(file: string, fallback: T): T {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJson(file: string, value: unknown) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

class Store {
  settings: AppSettings;
  projects: Project[];
  threads: ThreadMeta[];

  constructor() {
    const raw = readJson<AppSettings>(SETTINGS_FILE, DEFAULT_SETTINGS);
    this.settings = { ...DEFAULT_SETTINGS, ...raw };
    this.projects = readJson<Project[]>(PROJECTS_FILE, []);
    this.threads = readJson<ThreadMeta[]>(THREADS_FILE, []);
  }

  saveSettings(settings: AppSettings) {
    this.settings = settings;
    writeJson(SETTINGS_FILE, settings);
  }

  addProject(project: Project) {
    this.projects.push(project);
    writeJson(PROJECTS_FILE, this.projects);
  }

  removeProject(projectId: string) {
    this.projects = this.projects.filter((p) => p.id !== projectId);
    writeJson(PROJECTS_FILE, this.projects);
  }

  upsertThread(thread: ThreadMeta) {
    const idx = this.threads.findIndex((t) => t.id === thread.id);
    if (idx >= 0) this.threads[idx] = thread;
    else this.threads.push(thread);
    writeJson(THREADS_FILE, this.threads);
  }

  deleteThread(threadId: string) {
    this.threads = this.threads.filter((t) => t.id !== threadId);
    writeJson(THREADS_FILE, this.threads);
  }

  getThread(threadId: string) {
    return this.threads.find((t) => t.id === threadId);
  }
}

export const store = new Store();
