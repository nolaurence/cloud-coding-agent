import fs from "node:fs";
import {
  AppSettings,
  DEFAULT_SETTINGS,
  Project,
  ThreadMeta,
} from "@cca/protocol";
import { PROJECTS_FILE, SETTINGS_FILE, THREADS_FILE } from "./env.js";
import { query, usingPostgres } from "./db.js";

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
  void task().catch((err) => console.error("[cca] db write failed", err));
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
    if (usingPostgres()) {
      await this.initFromPg();
    } else {
      const raw = readJson<AppSettings>(SETTINGS_FILE, DEFAULT_SETTINGS);
      this.settings = { ...DEFAULT_SETTINGS, ...raw };
      this.projects = readJson<Project[]>(PROJECTS_FILE, []);
      this.threads = readJson<ThreadMeta[]>(THREADS_FILE, []);
    }
  }

  private async initFromPg() {
    const [settingsRows, projectRows, threadRows] = await Promise.all([
      query("SELECT data FROM settings WHERE id = 1"),
      query("SELECT id, name, path FROM projects"),
      query("SELECT data FROM threads"),
    ]);
    const pgEmpty =
      settingsRows.rows.length === 0 && projectRows.rows.length === 0 && threadRows.rows.length === 0;

    if (pgEmpty) {
      const jsonSettings = readJson<AppSettings | null>(SETTINGS_FILE, null);
      const jsonProjects = readJson<Project[]>(PROJECTS_FILE, []);
      const jsonThreads = readJson<ThreadMeta[]>(THREADS_FILE, []);
      if (jsonSettings || jsonProjects.length > 0 || jsonThreads.length > 0) {
        console.log("[cca] migrating json store -> postgres");
        if (jsonSettings) {
          await query("INSERT INTO settings (id, data) VALUES (1, $1) ON CONFLICT (id) DO NOTHING", [
            JSON.stringify(jsonSettings),
          ]);
        }
        for (const p of jsonProjects) {
          await query("INSERT INTO projects (id, name, path) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING", [
            p.id,
            p.name,
            p.path,
          ]);
        }
        for (const t of jsonThreads) {
          await query("INSERT INTO threads (id, data) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING", [
            t.id,
            JSON.stringify(t),
          ]);
        }
      }
      this.settings = { ...DEFAULT_SETTINGS, ...(jsonSettings ?? {}) };
      this.projects = jsonProjects;
      this.threads = jsonThreads;
      return;
    }

    this.settings = {
      ...DEFAULT_SETTINGS,
      ...((settingsRows.rows[0]?.data as AppSettings | undefined) ?? {}),
    };
    this.projects = projectRows.rows as Project[];
    this.threads = threadRows.rows.map((r) => r.data as ThreadMeta);
  }

  saveSettings(settings: AppSettings) {
    this.settings = settings;
    if (usingPostgres()) {
      persist(() =>
        query(
          "INSERT INTO settings (id, data) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data",
          [JSON.stringify(settings)],
        ),
      );
    } else {
      writeJson(SETTINGS_FILE, settings);
    }
  }

  addProject(project: Project) {
    this.projects.push(project);
    if (usingPostgres()) {
      persist(() =>
        query("INSERT INTO projects (id, name, path) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING", [
          project.id,
          project.name,
          project.path,
        ]),
      );
    } else {
      writeJson(PROJECTS_FILE, this.projects);
    }
  }

  removeProject(projectId: string) {
    this.projects = this.projects.filter((p) => p.id !== projectId);
    if (usingPostgres()) {
      persist(() => query("DELETE FROM projects WHERE id = $1", [projectId]));
    } else {
      writeJson(PROJECTS_FILE, this.projects);
    }
  }

  upsertThread(thread: ThreadMeta) {
    const idx = this.threads.findIndex((t) => t.id === thread.id);
    if (idx >= 0) this.threads[idx] = thread;
    else this.threads.push(thread);
    if (usingPostgres()) {
      persist(() =>
        query(
          "INSERT INTO threads (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data",
          [thread.id, JSON.stringify(thread)],
        ),
      );
    } else {
      writeJson(THREADS_FILE, this.threads);
    }
  }

  deleteThread(threadId: string) {
    this.threads = this.threads.filter((t) => t.id !== threadId);
    if (usingPostgres()) {
      persist(() => query("DELETE FROM threads WHERE id = $1", [threadId]));
    } else {
      writeJson(THREADS_FILE, this.threads);
    }
  }

  getThread(threadId: string) {
    return this.threads.find((t) => t.id === threadId);
  }
}

export const store = new Store();
