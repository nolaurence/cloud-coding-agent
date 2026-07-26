import fs from "node:fs";
import {
  AppSettings,
  DEFAULT_SETTINGS,
  flattenModels,
  normalizeModelRefReasoning,
  Project,
  ThreadMeta,
} from "@cca/protocol";
import type { ModelOption } from "@cca/protocol";
import { PROJECTS_FILE, SETTINGS_FILE, THREADS_FILE } from "./env.js";
import { enqueueWrite, query, transaction, usingMysql } from "./db.js";

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

function persist(task: () => Promise<unknown>) {
  enqueueWrite(task);
}

function parseJson<T>(value: unknown): T {
  const normalized = Buffer.isBuffer(value) ? value.toString("utf8") : value;
  return (typeof normalized === "string" ? JSON.parse(normalized) : normalized) as T;
}

class Store {
  settings: AppSettings;
  projects: Project[];
  threads: ThreadMeta[];

  constructor() {
    this.settings = { ...DEFAULT_SETTINGS };
    this.projects = [];
    this.threads = [];
  }

  async init() {
    if (usingMysql()) {
      await this.initFromMysql();
    } else {
      const raw = readJson<AppSettings>(SETTINGS_FILE, DEFAULT_SETTINGS);
      this.settings = { ...DEFAULT_SETTINGS, ...raw };
      this.projects = readJson<Project[]>(PROJECTS_FILE, []);
      this.threads = readJson<ThreadMeta[]>(THREADS_FILE, []);
    }
    this.normalizeStoredReasoningEfforts();
  }

  normalizeStoredReasoningEfforts(
    modelOptions: readonly ModelOption[] = flattenModels(this.settings),
  ): boolean {
    let changed = false;
    const defaultModel = this.settings.defaultModel
      ? normalizeModelRefReasoning(this.settings.defaultModel, modelOptions)
      : undefined;
    if (defaultModel !== this.settings.defaultModel) {
      changed = true;
      this.settings = { ...this.settings, defaultModel };
      this.saveSettings(this.settings);
    }

    const changedThreads: ThreadMeta[] = [];
    this.threads = this.threads.map((thread) => {
      if (!thread.model) return thread;
      const model = normalizeModelRefReasoning(thread.model, modelOptions);
      if (model === thread.model) return thread;
      changed = true;
      const normalized = { ...thread, model };
      changedThreads.push(normalized);
      return normalized;
    });
    for (const thread of changedThreads) this.upsertThread(thread);
    return changed;
  }

  private async initFromMysql() {
    const [settingsRows, projectRows, threadRows] = await Promise.all([
      query<{ data: unknown }>("SELECT data FROM settings WHERE id = 1"),
      query<Project>("SELECT id, name, path FROM projects"),
      query<{ data: unknown }>("SELECT data FROM threads"),
    ]);
    const mysqlEmpty =
      settingsRows.rows.length === 0 && projectRows.rows.length === 0 && threadRows.rows.length === 0;

    if (mysqlEmpty) {
      const jsonSettings = readJson<AppSettings | null>(SETTINGS_FILE, null);
      const jsonProjects = readJson<Project[]>(PROJECTS_FILE, []);
      const jsonThreads = readJson<ThreadMeta[]>(THREADS_FILE, []);
      if (jsonSettings || jsonProjects.length > 0 || jsonThreads.length > 0) {
        console.log("[cca] migrating json store -> mysql");
        await transaction(async (txQuery) => {
          if (jsonSettings) {
            await txQuery("INSERT INTO settings (id, data) VALUES (1, ?) ON DUPLICATE KEY UPDATE id = 1", [
              JSON.stringify(jsonSettings),
            ]);
          }
          for (const p of jsonProjects) {
            await txQuery(
              "INSERT INTO projects (id, name, path) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE id = ?",
              [p.id, p.name, p.path, p.id],
            );
          }
          for (const t of jsonThreads) {
            await txQuery("INSERT INTO threads (id, data) VALUES (?, ?) ON DUPLICATE KEY UPDATE id = ?", [
              t.id,
              JSON.stringify(t),
              t.id,
            ]);
          }
        });
      }
      this.settings = { ...DEFAULT_SETTINGS, ...(jsonSettings ?? {}) };
      this.projects = jsonProjects;
      this.threads = jsonThreads;
      return;
    }

    this.settings = {
      ...DEFAULT_SETTINGS,
      ...(settingsRows.rows[0] ? parseJson<AppSettings>(settingsRows.rows[0].data) : {}),
    };
    this.projects = projectRows.rows;
    this.threads = threadRows.rows.map((r) => parseJson<ThreadMeta>(r.data));
  }

  saveSettings(settings: AppSettings) {
    this.settings = settings;
    if (usingMysql()) {
      persist(() =>
        query(
          "INSERT INTO settings (id, data) VALUES (1, ?) ON DUPLICATE KEY UPDATE data = ?",
          [JSON.stringify(settings), JSON.stringify(settings)],
        ),
      );
    } else {
      writeJson(SETTINGS_FILE, settings);
    }
  }

  addProject(project: Project) {
    this.projects.push(project);
    if (usingMysql()) {
      persist(() =>
        query(
          "INSERT INTO projects (id, name, path) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE id = ?",
          [project.id, project.name, project.path, project.id],
        ),
      );
    } else {
      writeJson(PROJECTS_FILE, this.projects);
    }
  }

  removeProject(projectId: string) {
    this.projects = this.projects.filter((p) => p.id !== projectId);
    if (usingMysql()) {
      persist(() => query("DELETE FROM projects WHERE id = ?", [projectId]));
    } else {
      writeJson(PROJECTS_FILE, this.projects);
    }
  }

  upsertThread(thread: ThreadMeta) {
    const idx = this.threads.findIndex((t) => t.id === thread.id);
    if (idx >= 0) this.threads[idx] = thread;
    else this.threads.push(thread);
    if (usingMysql()) {
      persist(() =>
        query(
          "INSERT INTO threads (id, data) VALUES (?, ?) ON DUPLICATE KEY UPDATE data = ?",
          [thread.id, JSON.stringify(thread), JSON.stringify(thread)],
        ),
      );
    } else {
      writeJson(THREADS_FILE, this.threads);
    }
  }

  deleteThread(threadId: string) {
    this.threads = this.threads.filter((t) => t.id !== threadId);
    if (usingMysql()) {
      persist(() => query("DELETE FROM threads WHERE id = ?", [threadId]));
    } else {
      writeJson(THREADS_FILE, this.threads);
    }
  }

  getThread(threadId: string) {
    return this.threads.find((t) => t.id === threadId);
  }
}

export const store = new Store();
