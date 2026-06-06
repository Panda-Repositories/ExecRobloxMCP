import mysql from "mysql2/promise";

let pool: mysql.Pool | null = null;

export function isDbConfigured(): boolean {
  return Boolean(process.env.DB_HOST);
}

export function getPool(): mysql.Pool {
  if (!isDbConfigured()) {
    throw new Error("DB not configured (set DB_HOST to enable production mode)");
  }
  if (!pool) {
    pool = mysql.createPool({
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT ?? 3306),
      user: process.env.DB_USER ?? "root",
      password: process.env.DB_PASS ?? "",
      database: process.env.DB_NAME ?? "robloxmcp",
      waitForConnections: true,
      connectionLimit: 10,
      enableKeepAlive: true,
      keepAliveInitialDelay: 10_000,
    });
  }
  return pool;
}

export async function dbHealth(): Promise<boolean> {
  if (!isDbConfigured()) return false;
  try {
    const [rows] = await getPool().query("SELECT 1 AS ok");
    return Array.isArray(rows) && rows.length > 0;
  } catch {
    return false;
  }
}

export async function closeDb() {
  if (pool) { await pool.end(); pool = null; }
}
