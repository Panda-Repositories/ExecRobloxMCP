import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";
import { getPool, isDbConfigured } from "./db.js";

export function maskIp(ip: string | undefined): string {
  if (!ip) return "***";
  const stripped = ip.replace(/^::ffff:/, "");
  if (stripped === "::1" || stripped === "127.0.0.1") return "localhost";
  if (stripped.includes(":")) {
    const parts = stripped.split(":").filter(Boolean);
    if (parts.length <= 2) return parts[0] + ":****";
    return parts.slice(0, parts.length - 2).join(":") + ":****:****";
  }
  const parts = stripped.split(".");
  if (parts.length === 4) return `${parts[0]}.${parts[1]}.${parts[2]}.***`;
  return "***";
}

export function newApiKey(): string {
  return randomBytes(32).toString("hex");
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validEmail(s: string): boolean {
  return typeof s === "string" && s.length <= 255 && EMAIL_RE.test(s);
}

export function validPassword(s: string): boolean {
  return typeof s === "string" && s.length >= 8 && s.length <= 200;
}

export async function registerUser(email: string, password: string): Promise<{ user_id: number; api_key: string }> {
  if (!validEmail(email)) throw new Error("invalid email");
  if (!validPassword(password)) throw new Error("password must be 8-200 chars");
  const pool = getPool();
  const hash = await bcrypt.hash(password, 10);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [r] = await conn.query<any>("INSERT INTO users (email, password_hash) VALUES (?, ?)", [email.toLowerCase(), hash]);
    const userId = r.insertId as number;
    const api = newApiKey();
    await conn.query("INSERT INTO api_keys (user_id, api_key, label) VALUES (?, ?, ?)", [userId, api, "default"]);
    await conn.commit();
    return { user_id: userId, api_key: api };
  } catch (e: any) {
    await conn.rollback();
    if (e.code === "ER_DUP_ENTRY") throw new Error("email already registered");
    throw e;
  } finally {
    conn.release();
  }
}

export interface LoginResult { user_id: number; email: string; api_keys: ApiKeyRow[]; }
export interface ApiKeyRow { id: number; api_key: string; label: string | null; created_at: string; last_used_at: string | null; revoked_at: string | null; }

export async function loginUser(email: string, password: string, ipMasked: string, userAgent: string | null): Promise<LoginResult | null> {
  if (!validEmail(email) || !validPassword(password)) return null;
  const pool = getPool();
  const [rows] = await pool.query<any>("SELECT id, email, password_hash FROM users WHERE email = ? LIMIT 1", [email.toLowerCase()]);
  const found = Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
  let success = false;
  if (found) {
    success = await bcrypt.compare(password, found.password_hash);
  }
  await pool.query(
    "INSERT INTO login_history (user_id, email, ip_masked, user_agent, success) VALUES (?, ?, ?, ?, ?)",
    [found?.id ?? null, email.toLowerCase(), ipMasked, (userAgent ?? "").slice(0, 255), success ? 1 : 0]
  );
  if (!found || !success) return null;
  const [keys] = await pool.query<any>(
    "SELECT id, api_key, label, created_at, last_used_at, revoked_at FROM api_keys WHERE user_id = ? ORDER BY created_at DESC",
    [found.id]
  );
  return { user_id: found.id, email: found.email, api_keys: keys as ApiKeyRow[] };
}

export interface ResolvedKey { user_id: number; api_key_id: number; email: string; }

export async function resolveApiKey(key: string): Promise<ResolvedKey | null> {
  if (!key || key.length !== 64) return null;
  const pool = getPool();
  const [rows] = await pool.query<any>(
    "SELECT k.id AS api_key_id, k.user_id, k.revoked_at, u.email FROM api_keys k JOIN users u ON u.id = k.user_id WHERE k.api_key = ? LIMIT 1",
    [key]
  );
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const r = rows[0];
  if (r.revoked_at) return null;
  await pool.query("UPDATE api_keys SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?", [r.api_key_id]).catch(() => {});
  return { user_id: r.user_id, api_key_id: r.api_key_id, email: r.email };
}

export async function listApiKeys(userId: number): Promise<ApiKeyRow[]> {
  const [rows] = await getPool().query<any>(
    "SELECT id, api_key, label, created_at, last_used_at, revoked_at FROM api_keys WHERE user_id = ? ORDER BY created_at DESC",
    [userId]
  );
  return rows as ApiKeyRow[];
}

export async function createApiKey(userId: number, label: string | null): Promise<string> {
  const api = newApiKey();
  await getPool().query("INSERT INTO api_keys (user_id, api_key, label) VALUES (?, ?, ?)", [userId, api, (label ?? "").slice(0, 100) || null]);
  return api;
}

export async function revokeApiKey(userId: number, keyId: number): Promise<boolean> {
  const [r] = await getPool().query<any>(
    "UPDATE api_keys SET revoked_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ? AND revoked_at IS NULL",
    [keyId, userId]
  );
  return r.affectedRows > 0;
}

export async function getLoginHistory(userId: number, limit = 50): Promise<any[]> {
  const [rows] = await getPool().query<any>(
    "SELECT ip_masked, user_agent, success, at FROM login_history WHERE user_id = ? ORDER BY at DESC LIMIT ?",
    [userId, Math.min(Math.max(1, limit), 500)]
  );
  return rows;
}

export async function recordSessionStart(
  userId: number, apiKeyId: number, clientId: string,
  robloxUserId: number | null, robloxUserName: string | null,
  deviceType: string, executor: string,
  capabilities: any, ipMasked: string,
): Promise<number> {
  if (!isDbConfigured()) return 0;
  const [r] = await getPool().query<any>(
    "INSERT INTO client_sessions (user_id, api_key_id, client_id, roblox_user_id, roblox_user_name, device_type, executor, capabilities, ip_masked) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [userId, apiKeyId, clientId, robloxUserId, robloxUserName, deviceType, executor, JSON.stringify(capabilities ?? {}), ipMasked]
  );
  return r.insertId as number;
}

export async function recordSessionEnd(sessionId: number) {
  if (!isDbConfigured() || !sessionId) return;
  await getPool().query(
    "UPDATE client_sessions SET disconnected_at = CURRENT_TIMESTAMP WHERE id = ? AND disconnected_at IS NULL",
    [sessionId]
  );
}

export async function recentSessions(userId: number, limit = 50): Promise<any[]> {
  const [rows] = await getPool().query<any>(
    "SELECT client_id, roblox_user_id, roblox_user_name, device_type, executor, ip_masked, connected_at, disconnected_at FROM client_sessions WHERE user_id = ? ORDER BY connected_at DESC LIMIT ?",
    [userId, Math.min(Math.max(1, limit), 500)]
  );
  return rows;
}
