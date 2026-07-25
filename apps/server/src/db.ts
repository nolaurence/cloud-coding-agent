import pg from "pg";

let pool: pg.Pool | null = null;

export function usingPostgres(): boolean {
  return pool !== null;
}

export async function initDb(connectionString: string): Promise<void> {
  pool = new pg.Pool({ connectionString, max: 5 });
  await pool.query("SELECT 1");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS settings (
      id INT PRIMARY KEY,
      data JSONB NOT NULL
    );
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY,
      data JSONB NOT NULL
    );
    CREATE TABLE IF NOT EXISTS users (
      username TEXT PRIMARY KEY,
      role TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      created_at BIGINT NOT NULL
    );
  `);
  console.log("[cca] postgres connected");
}

export function query(text: string, params?: unknown[]) {
  if (!pool) throw new Error("database not initialized");
  return pool.query(text, params);
}

export async function closeDb() {
  await pool?.end();
  pool = null;
}
