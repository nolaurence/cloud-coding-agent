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
import { databaseDialect, enqueueWrite, query, transaction, upsert, usingDatabase } from "./db.js";

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
    if (usingDatabase()) {
      await this.initFromDatabase();
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

  private async initFromDatabase() {
    const [settingsRows, projectRows, threadRows] = await Promise.all([
      query<{ data: unknown }>("SELECT data FROM settings WHERE id = 1"),
      query<Project>("SELECT id, name, path FROM projects"),
      query<{ data: unknown }>("SELECT data FROM threads"),
    ]);
    const databaseEmpty =
      settingsRows.rows.length === 0 && projectRows.rows.length === 0 && threadRows.rows.length === 0;

    if (databaseEmpty) {
      const jsonSettings = readJson<AppSettings | null>(SETTINGS_FILE, null);
      const jsonProjects = readJson<Project[]>(PROJECTS_FILE, []);
      const jsonThreads = readJson<ThreadMeta[]>(THREADS_FILE, []);
      if (jsonSettings || jsonProjects.length > 0 || jsonThreads.length > 0) {
        console.log(`[cca] migrating json store -> ${databaseDialect()}`);
        await transaction(async (txQuery) => {
          if (jsonSettings) {
            await upsert(
              {
                table: "settings",
                values: { id: 1, data: JSON.stringify(jsonSettings) },
                conflictColumns: ["id"],
              },
              txQuery,
            );
          }
          for (const p of jsonProjects) {
            await upsert(
              {
                table: "projects",
                values: { id: p.id, name: p.name, path: p.path },
                conflictColumns: ["id"],
              },
              txQuery,
            );
          }
          for (const t of jsonThreads) {
            await upsert(
              {
                table: "threads",
                values: { id: t.id, data: JSON.stringify(t) },
                conflictColumns: ["id"],
              },
              txQuery,
            );
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
    if (usingDatabase()) {
      persist(() =>
        upsert({
          table: "settings",
          values: { id: 1, data: JSON.stringify(settings) },
          conflictColumns: ["id"],
          updateColumns: ["data"],
        }),
      );
    } else {
      writeJson(SETTINGS_FILE, settings);
    }
  }

  addProject(project: Project) {
    this.projects.push(project);
    if (usingDatabase()) {
      persist(() =>
        upsert({
          table: "projects",
          values: { id: project.id, name: project.name, path: project.path },
          conflictColumns: ["id"],
        }),
      );
    } else {
      writeJson(PROJECTS_FILE, this.projects);
    }
  }

  removeProject(projectId: string) {
    this.projects = this.projects.filter((p) => p.id !== projectId);
    if (usingDatabase()) {
      persist(() => query("DELETE FROM projects WHERE id = ?", [projectId]));
    } else {
      writeJson(PROJECTS_FILE, this.projects);
    }
  }

  upsertThread(thread: ThreadMeta) {
    const idx = this.threads.findIndex((t) => t.id === thread.id);
    if (idx >= 0) this.threads[idx] = thread;
    else this.threads.push(thread);
    if (usingDatabase()) {
      persist(() =>
        upsert({
          table: "threads",
          values: { id: thread.id, data: JSON.stringify(thread) },
          conflictColumns: ["id"],
          updateColumns: ["data"],
        }),
      );
    } else {
      writeJson(THREADS_FILE, this.threads);
    }
  }

  deleteThread(threadId: string) {
    this.threads = this.threads.filter((t) => t.id !== threadId);
    if (usingDatabase()) {
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
