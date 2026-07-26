import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import mysql, {
  type Pool,
  type PoolConnection,
  type ResultSetHeader,
  type RowDataPacket,
} from "mysql2/promise";

export type DbDialect = "mysql" | "sqlite";

type DbValue = string | number | bigint | boolean | Date | null | Buffer | Uint8Array;

type ParsedDatabaseUrl =
  | { dialect: "mysql"; connectionString: string }
  | { dialect: "sqlite"; filename: string };

export interface UpsertSpec {
  table: "settings" | "projects" | "threads" | "users";
  values: Record<string, DbValue>;
  conflictColumns: string[];
  updateColumns?: string[];
}

const MYSQL_CREATE_TABLES = [
  `CREATE TABLE IF NOT EXISTS settings (
    id INT NOT NULL PRIMARY KEY,
    data JSON NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS projects (
    id VARCHAR(191) COLLATE utf8mb4_bin NOT NULL PRIMARY KEY,
    name TEXT NOT NULL,
    path TEXT NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS threads (
    id VARCHAR(191) COLLATE utf8mb4_bin NOT NULL PRIMARY KEY,
    data JSON NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS users (
    username VARCHAR(191) COLLATE utf8mb4_bin NOT NULL PRIMARY KEY,
    role VARCHAR(16) NOT NULL,
    password_hash CHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    salt CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    created_at BIGINT NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
];

const SQLITE_CREATE_TABLES = `
  CREATE TABLE IF NOT EXISTS settings (
    id INTEGER NOT NULL PRIMARY KEY,
    data TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT COLLATE BINARY NOT NULL PRIMARY KEY,
    name TEXT NOT NULL,
    path TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS threads (
    id TEXT COLLATE BINARY NOT NULL PRIMARY KEY,
    data TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS users (
    username TEXT COLLATE BINARY NOT NULL PRIMARY KEY,
    role TEXT NOT NULL,
    password_hash TEXT COLLATE BINARY NOT NULL,
    salt TEXT COLLATE BINARY NOT NULL,
    created_at INTEGER NOT NULL
  );
`;

let dialect: DbDialect | null = null;
let mysqlPool: Pool | null = null;
let sqliteDatabase: DatabaseSync | null = null;
let writeQueue: Promise<void> = Promise.resolve();

export type DbQuery = <Row = Record<string, unknown>>(
  text: string,
  params?: DbValue[],
) => Promise<{ rows: Row[] }>;

export function parseDatabaseUrl(connectionString: string): ParsedDatabaseUrl {
  if (connectionString.startsWith("mysql://")) {
    return { dialect: "mysql", connectionString };
  }
  if (!connectionString.startsWith("sqlite:")) {
    throw new Error("DATABASE_URL 必须使用 mysql:// 或 sqlite: 连接串");
  }

  let parsed: URL;
  try {
    parsed = new URL(connectionString);
  } catch {
    throw new Error("SQLite DATABASE_URL 格式无效");
  }
  if (parsed.host || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("SQLite DATABASE_URL 仅支持本地文件路径");
  }

  let filename: string;
  try {
    filename = decodeURIComponent(parsed.pathname);
  } catch {
    throw new Error("SQLite DATABASE_URL 路径编码无效");
  }
  if (process.platform === "win32" && /^\/[a-zA-Z]:\//.test(filename)) {
    filename = filename.slice(1);
  }
  if (!filename || filename.includes("\0")) {
    throw new Error("SQLite DATABASE_URL 缺少有效的数据库文件路径");
  }

  return {
    dialect: "sqlite",
    filename: filename === ":memory:" ? filename : path.resolve(filename),
  };
}

export function usingDatabase(): boolean {
  return dialect !== null;
}

export function databaseDialect(): DbDialect | null {
  return dialect;
}

export async function initDb(connectionString: string): Promise<void> {
  if (usingDatabase()) {
    throw new Error("database already initialized");
  }

  const parsed = parseDatabaseUrl(connectionString);
  if (parsed.dialect === "mysql") {
    await initMysql(parsed.connectionString);
  } else {
    initSqlite(parsed.filename);
  }
}

async function initMysql(connectionString: string): Promise<void> {
  const candidate = mysql.createPool({
    uri: connectionString,
    waitForConnections: true,
    connectionLimit: 5,
    queueLimit: 0,
  });

  try {
    await candidate.query("SELECT 1");
    for (const statement of MYSQL_CREATE_TABLES) {
      await candidate.query(statement);
    }
  } catch (err) {
    await candidate.end();
    throw err;
  }

  mysqlPool = candidate;
  dialect = "mysql";
  console.log("[cca] mysql connected");
}

function initSqlite(filename: string): void {
  if (filename !== ":memory:") {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
  }

  const candidate = new DatabaseSync(filename);
  try {
    candidate.exec("PRAGMA busy_timeout = 5000;");
    candidate.exec("PRAGMA foreign_keys = ON;");
    if (filename !== ":memory:") candidate.exec("PRAGMA journal_mode = WAL;");
    candidate.exec(SQLITE_CREATE_TABLES);
  } catch (err) {
    candidate.close();
    throw err;
  }

  sqliteDatabase = candidate;
  dialect = "sqlite";
  console.log(`[cca] sqlite connected: ${filename}`);
}

async function executeMysqlQuery<Row>(
  executor: Pool | PoolConnection,
  text: string,
  params: DbValue[] = [],
): Promise<{ rows: Row[] }> {
  const [result] = await executor.execute<RowDataPacket[] | ResultSetHeader>(text, params);
  return { rows: Array.isArray(result) ? (result as unknown as Row[]) : [] };
}

function toSqliteValue(value: DbValue): SQLInputValue {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "boolean") return value ? 1 : 0;
  return value;
}

function executeSqliteQuery<Row>(
  database: DatabaseSync,
  text: string,
  params: DbValue[] = [],
): { rows: Row[] } {
  const statement = database.prepare(text);
  const rows = statement
    .all(...params.map(toSqliteValue))
    .map((row) => ({ ...row }) as Row);
  return { rows };
}

export const query: DbQuery = async (text, params = []) => {
  if (dialect === "mysql" && mysqlPool) return executeMysqlQuery(mysqlPool, text, params);
  if (dialect === "sqlite" && sqliteDatabase) {
    return executeSqliteQuery(sqliteDatabase, text, params);
  }
  throw new Error("database not initialized");
};

export async function transaction<T>(task: (query: DbQuery) => Promise<T>): Promise<T> {
  if (dialect === "mysql" && mysqlPool) {
    const connection = await mysqlPool.getConnection();
    const transactionQuery: DbQuery = (text, params = []) =>
      executeMysqlQuery(connection, text, params);

    try {
      await connection.beginTransaction();
      const result = await task(transactionQuery);
      await connection.commit();
      return result;
    } catch (err) {
      await connection.rollback().catch((rollbackErr) => {
        console.error("[cca] db rollback failed", rollbackErr);
      });
      throw err;
    } finally {
      connection.release();
    }
  }

  if (dialect === "sqlite" && sqliteDatabase) {
    const database = sqliteDatabase;
    const transactionQuery: DbQuery = async (text, params = []) =>
      executeSqliteQuery(database, text, params);
    database.exec("BEGIN IMMEDIATE");
    try {
      const result = await task(transactionQuery);
      database.exec("COMMIT");
      return result;
    } catch (err) {
      try {
        database.exec("ROLLBACK");
      } catch (rollbackErr) {
        console.error("[cca] db rollback failed", rollbackErr);
      }
      throw err;
    }
  }

  throw new Error("database not initialized");
}

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(identifier)) {
    throw new Error(`invalid database identifier: ${identifier}`);
  }
  return dialect === "mysql" ? `\`${identifier}\`` : `"${identifier}"`;
}

export async function upsert(spec: UpsertSpec, executor: DbQuery = query): Promise<void> {
  if (!dialect) throw new Error("database not initialized");

  const columns = Object.keys(spec.values);
  if (columns.length === 0 || spec.conflictColumns.length === 0) {
    throw new Error("upsert requires values and conflict columns");
  }
  const knownColumns = new Set(columns);
  for (const column of [...spec.conflictColumns, ...(spec.updateColumns ?? [])]) {
    if (!knownColumns.has(column)) throw new Error(`upsert column is missing from values: ${column}`);
  }

  const table = quoteIdentifier(spec.table);
  const quotedColumns = columns.map(quoteIdentifier);
  const placeholders = columns.map(() => "?").join(", ");
  const updateColumns = spec.updateColumns ?? [];
  let conflictClause: string;
  if (dialect === "mysql") {
    const assignments =
      updateColumns.length > 0
        ? updateColumns.map((column) => {
            const quoted = quoteIdentifier(column);
            return `${quoted} = VALUES(${quoted})`;
          })
        : [`${quoteIdentifier(spec.conflictColumns[0]!)} = ${quoteIdentifier(spec.conflictColumns[0]!)}`];
    conflictClause = `ON DUPLICATE KEY UPDATE ${assignments.join(", ")}`;
  } else if (updateColumns.length > 0) {
    const conflictColumns = spec.conflictColumns.map(quoteIdentifier).join(", ");
    const assignments = updateColumns.map((column) => {
      const quoted = quoteIdentifier(column);
      return `${quoted} = excluded.${quoted}`;
    });
    conflictClause = `ON CONFLICT (${conflictColumns}) DO UPDATE SET ${assignments.join(", ")}`;
  } else {
    const conflictColumns = spec.conflictColumns.map(quoteIdentifier).join(", ");
    conflictClause = `ON CONFLICT (${conflictColumns}) DO NOTHING`;
  }

  await executor(
    `INSERT INTO ${table} (${quotedColumns.join(", ")}) VALUES (${placeholders}) ${conflictClause}`,
    columns.map((column) => spec.values[column]!),
  );
}

export function enqueueWrite(task: () => Promise<unknown>): void {
  writeQueue = writeQueue.then(async () => {
    try {
      await task();
    } catch (err) {
      console.error("[cca] db write failed", err);
    }
  });
}

export async function flushDbWrites(): Promise<void> {
  await writeQueue;
}

export async function closeDb(): Promise<void> {
  await flushDbWrites();

  const currentMysqlPool = mysqlPool;
  const currentSqliteDatabase = sqliteDatabase;
  mysqlPool = null;
  sqliteDatabase = null;
  dialect = null;

  await currentMysqlPool?.end();
  currentSqliteDatabase?.close();
}
