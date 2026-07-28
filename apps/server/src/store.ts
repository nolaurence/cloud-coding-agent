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

type StoredProject = Omit<Project, "ownerId"> & { ownerId?: string | null };

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
      this.projects = readJson<StoredProject[]>(PROJECTS_FILE, []) as Project[];
      this.threads = readJson<ThreadMeta[]>(THREADS_FILE, []);
    }
    this.normalizeStoredReasoningEfforts();
    const connectors = this.settings.connectors.map((connector) => ({
      ...connector,
      allowedUserIds: connector.allowedUserIds?.filter((value) => typeof value === "string"),
      ownerId: connector.ownerId ||
        this.projects.find((project) => project.id === connector.projectId)?.ownerId,
    }));
    const ownershipChanged = connectors.some(
      (connector, index) => connector.ownerId !== this.settings.connectors[index]?.ownerId,
    );
    this.settings = { ...this.settings, connectors };
    if (ownershipChanged) this.saveSettings(this.settings);
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
      query<StoredProject>("SELECT id, name, path, owner_id AS ownerId FROM projects"),
      query<{ data: unknown }>("SELECT data FROM threads"),
    ]);
    const databaseEmpty =
      settingsRows.rows.length === 0 && projectRows.rows.length === 0 && threadRows.rows.length === 0;

    if (databaseEmpty) {
      const jsonSettings = readJson<AppSettings | null>(SETTINGS_FILE, null);
      const jsonProjects = readJson<StoredProject[]>(PROJECTS_FILE, []);
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
                values: { id: p.id, name: p.name, path: p.path, owner_id: p.ownerId ?? null },
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
      this.projects = jsonProjects as Project[];
      this.threads = jsonThreads;
      return;
    }

    this.settings = {
      ...DEFAULT_SETTINGS,
      ...(settingsRows.rows[0] ? parseJson<AppSettings>(settingsRows.rows[0].data) : {}),
    };
    this.projects = projectRows.rows as Project[];
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

  async migrateLegacyWorkspaceOwnership(ownerId: string): Promise<boolean> {
    const legacyProjects = this.projects.filter((project) => !project.ownerId);
    if (legacyProjects.length === 0) return false;

    const legacyProjectIds = new Set(legacyProjects.map((project) => project.id));
    const changedThreads = this.threads.filter(
      (thread) => !thread.userId && legacyProjectIds.has(thread.projectId),
    );
    const previousSettings = this.settings;
    const previousProjects = this.projects;
    const previousThreads = this.threads;
    this.settings = {
      ...this.settings,
      connectors: this.settings.connectors.map((connector) =>
        !connector.ownerId && legacyProjectIds.has(connector.projectId)
          ? { ...connector, ownerId }
          : connector,
      ),
    };
    this.projects = this.projects.map((project) =>
      legacyProjectIds.has(project.id) ? { ...project, ownerId } : project,
    );
    this.threads = this.threads.map((thread) =>
      changedThreads.some((candidate) => candidate.id === thread.id)
        ? { ...thread, userId: ownerId }
        : thread,
    );

    try {
      if (usingDatabase()) {
        await transaction(async (txQuery) => {
          await upsert(
            {
              table: "settings",
              values: { id: 1, data: JSON.stringify(this.settings) },
              conflictColumns: ["id"],
              updateColumns: ["data"],
            },
            txQuery,
          );
          for (const project of this.projects.filter((item) => legacyProjectIds.has(item.id))) {
            await upsert(
              {
                table: "projects",
                values: {
                  id: project.id,
                  name: project.name,
                  path: project.path,
                  owner_id: ownerId,
                },
                conflictColumns: ["id"],
                updateColumns: ["name", "path", "owner_id"],
              },
              txQuery,
            );
          }
          for (const thread of this.threads.filter((item) =>
            changedThreads.some((candidate) => candidate.id === item.id),
          )) {
            await upsert(
              {
                table: "threads",
                values: { id: thread.id, data: JSON.stringify(thread) },
                conflictColumns: ["id"],
                updateColumns: ["data"],
              },
              txQuery,
            );
          }
        });
      } else {
        writeJson(SETTINGS_FILE, this.settings);
        writeJson(PROJECTS_FILE, this.projects);
        writeJson(THREADS_FILE, this.threads);
      }
    } catch (error) {
      this.settings = previousSettings;
      this.projects = previousProjects;
      this.threads = previousThreads;
      throw error;
    }
    return true;
  }

  async addProject(project: Project): Promise<void> {
    if (this.projects.some((candidate) => candidate.id === project.id)) {
      throw new Error("工作区已存在");
    }
    this.projects.push(project);
    try {
      if (usingDatabase()) {
        await upsert({
          table: "projects",
          values: {
            id: project.id,
            name: project.name,
            path: project.path,
            owner_id: project.ownerId,
          },
          conflictColumns: ["id"],
        });
      } else {
        writeJson(PROJECTS_FILE, this.projects);
      }
    } catch (error) {
      this.projects = this.projects.filter((candidate) => candidate.id !== project.id);
      throw error;
    }
  }

  async removeProject(projectId: string): Promise<void> {
    const previousProjects = this.projects;
    this.projects = this.projects.filter((project) => project.id !== projectId);
    try {
      if (usingDatabase()) {
        await query("DELETE FROM projects WHERE id = ?", [projectId]);
      } else {
        writeJson(PROJECTS_FILE, this.projects);
      }
    } catch (error) {
      this.projects = previousProjects;
      throw error;
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
