import mysql, {
  type Pool,
  type PoolConnection,
  type ResultSetHeader,
  type RowDataPacket,
} from "mysql2/promise";

type DbValue = string | number | bigint | boolean | Date | null | Buffer | Uint8Array;

const CREATE_TABLES = [
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

let pool: Pool | null = null;
let writeQueue: Promise<void> = Promise.resolve();

export type DbQuery = <Row = Record<string, unknown>>(
  text: string,
  params?: DbValue[],
) => Promise<{ rows: Row[] }>;

export function usingMysql(): boolean {
  return pool !== null;
}

export async function initDb(connectionString: string): Promise<void> {
  if (!connectionString.startsWith("mysql://")) {
    throw new Error("DATABASE_URL 必须使用 mysql:// 连接串");
  }

  const candidate = mysql.createPool({
    uri: connectionString,
    waitForConnections: true,
    connectionLimit: 5,
    queueLimit: 0,
  });

  try {
    await candidate.query("SELECT 1");
    for (const statement of CREATE_TABLES) {
      await candidate.query(statement);
    }
  } catch (err) {
    await candidate.end();
    throw err;
  }

  pool = candidate;
  console.log("[cca] mysql connected");
}

async function executeQuery<Row>(
  executor: Pool | PoolConnection,
  text: string,
  params: DbValue[] = [],
): Promise<{ rows: Row[] }> {
  const [result] = await executor.execute<RowDataPacket[] | ResultSetHeader>(text, params);
  return { rows: Array.isArray(result) ? (result as unknown as Row[]) : [] };
}

export const query: DbQuery = async (text, params = []) => {
  if (!pool) throw new Error("database not initialized");
  return executeQuery(pool, text, params);
};

export async function transaction<T>(task: (query: DbQuery) => Promise<T>): Promise<T> {
  if (!pool) throw new Error("database not initialized");
  const connection = await pool.getConnection();
  const transactionQuery: DbQuery = (text, params = []) => executeQuery(connection, text, params);

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

export async function closeDb() {
  await flushDbWrites();
  const current = pool;
  pool = null;
  await current?.end();
}
