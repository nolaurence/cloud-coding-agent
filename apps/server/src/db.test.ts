import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_SETTINGS, type AppSettings, type Project, type ThreadMeta } from "@cca/protocol";
import {
  closeDb,
  databaseDialect,
  flushDbWrites,
  initDb,
  parseDatabaseUrl,
  query,
  usingDatabase,
} from "./db.js";

test("parseDatabaseUrl accepts MySQL and local SQLite paths", () => {
  const mysqlUrl = "mysql://user:password@localhost:3306/cca";
  assert.deepEqual(parseDatabaseUrl(mysqlUrl), {
    dialect: "mysql",
    connectionString: mysqlUrl,
  });
  assert.deepEqual(parseDatabaseUrl("sqlite::memory:"), {
    dialect: "sqlite",
    filename: ":memory:",
  });
  assert.deepEqual(parseDatabaseUrl("sqlite:./data/cca.db"), {
    dialect: "sqlite",
    filename: path.resolve("data/cca.db"),
  });
  assert.equal(parseDatabaseUrl("sqlite:/data/cca.db").dialect, "sqlite");
});

test("parseDatabaseUrl rejects unsupported and remote SQLite URLs", () => {
  assert.throws(() => parseDatabaseUrl("postgresql://localhost/cca"), /mysql:\/\/ 或 sqlite:/);
  assert.throws(() => parseDatabaseUrl("sqlite:"), /缺少有效/);
  assert.throws(() => parseDatabaseUrl("sqlite://remote-host/data/cca.db"), /仅支持本地/);
  assert.throws(() => parseDatabaseUrl("sqlite:/data/cca.db?mode=ro"), /仅支持本地/);
});

test("SQLite migrates the complete JSON store and persists subsequent updates", async (t) => {
  const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "cca-sqlite-"));
  const originalDataDirectory = process.env.CCA_DATA_DIR;
  const originalAdminUsername = process.env.ADMIN_USERNAME;
  const originalAdminPassword = process.env.ADMIN_PASSWORD;
  process.env.CCA_DATA_DIR = dataDirectory;
  process.env.ADMIN_USERNAME = "legacy-admin";
  process.env.ADMIN_PASSWORD = "legacy-password";

  t.after(async () => {
    if (usingDatabase()) await closeDb();
    if (originalDataDirectory === undefined) delete process.env.CCA_DATA_DIR;
    else process.env.CCA_DATA_DIR = originalDataDirectory;
    if (originalAdminUsername === undefined) delete process.env.ADMIN_USERNAME;
    else process.env.ADMIN_USERNAME = originalAdminUsername;
    if (originalAdminPassword === undefined) delete process.env.ADMIN_PASSWORD;
    else process.env.ADMIN_PASSWORD = originalAdminPassword;
    fs.rmSync(dataDirectory, { recursive: true, force: true });
  });

  const legacySettings: AppSettings = {
    ...DEFAULT_SETTINGS,
    skillDirectories: ["/legacy/skills"],
  };
  const legacyProject: Project = {
    id: "project-1",
    name: "Legacy project",
    path: "/workspace/legacy",
  };
  const legacyThread: ThreadMeta = {
    id: "thread-1",
    projectId: legacyProject.id,
    title: "Legacy thread",
    createdAt: 1,
    updatedAt: 2,
    archived: false,
  };
  const legacySalt = crypto.randomBytes(16).toString("hex");
  const legacyUsers = [
    {
      username: "legacy-admin",
      role: "admin" as const,
      passwordHash: crypto.scryptSync("legacy-password", legacySalt, 64).toString("hex"),
      salt: legacySalt,
      createdAt: 3,
    },
  ];

  fs.writeFileSync(path.join(dataDirectory, "settings.json"), JSON.stringify(legacySettings));
  fs.writeFileSync(path.join(dataDirectory, "projects.json"), JSON.stringify([legacyProject]));
  fs.writeFileSync(path.join(dataDirectory, "threads.json"), JSON.stringify([legacyThread]));
  fs.writeFileSync(path.join(dataDirectory, "users.json"), JSON.stringify(legacyUsers));

  const databaseFile = path.join(dataDirectory, "database", "cca.db");
  const databaseUrl = `sqlite:${databaseFile.replaceAll(path.sep, "/")}`;
  await initDb(databaseUrl);

  const [{ store }, auth] = await Promise.all([import("./store.js"), import("./auth.js")]);
  await store.init();
  await auth.initAuth();

  assert.equal(databaseDialect(), "sqlite");
  assert.equal(store.settings.skillDirectories[0], "/legacy/skills");
  assert.deepEqual(store.projects, [legacyProject]);
  assert.deepEqual(store.threads, [legacyThread]);
  assert.equal(auth.verifyUser("legacy-admin", "legacy-password")?.role, "admin");
  assert.ok(fs.existsSync(databaseFile));

  const journalMode = await query<{ journal_mode: string }>("PRAGMA journal_mode");
  const foreignKeys = await query<{ foreign_keys: number }>("PRAGMA foreign_keys");
  const busyTimeout = await query<{ timeout: number }>("PRAGMA busy_timeout");
  assert.equal(journalMode.rows[0]?.journal_mode, "wal");
  assert.equal(foreignKeys.rows[0]?.foreign_keys, 1);
  assert.equal(busyTimeout.rows[0]?.timeout, 5000);

  store.saveSettings({ ...store.settings, disabledSkills: ["updated-skill"] });
  store.upsertThread({ ...legacyThread, title: "Updated thread", updatedAt: 4 });
  auth.registerUser("sqlite-user", "secret12");
  await flushDbWrites();
  await closeDb();

  for (const filename of ["settings.json", "projects.json", "threads.json", "users.json"]) {
    fs.rmSync(path.join(dataDirectory, filename));
  }

  await initDb(databaseUrl);
  await store.init();
  await auth.initAuth();

  assert.deepEqual(store.settings.disabledSkills, ["updated-skill"]);
  assert.equal(store.getThread(legacyThread.id)?.title, "Updated thread");
  assert.deepEqual(store.projects, [legacyProject]);
  assert.equal(auth.verifyUser("sqlite-user", "secret12")?.username, "sqlite-user");

  const userCount = await query<{ count: number }>("SELECT COUNT(*) AS count FROM users");
  assert.equal(userCount.rows[0]?.count, 2);
});
