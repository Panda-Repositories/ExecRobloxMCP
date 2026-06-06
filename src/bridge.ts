import { WebSocketServer, WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import { ClientRegistry, ClientInfo } from "./registry.js";
import { isDbConfigured } from "./db.js";
import { resolveApiKey, recordSessionStart, recordSessionEnd, maskIp } from "./auth.js";

export interface LogEntry { ts: number; level: string; message: string; user_id: number | null; }
export interface RecordedScript { ts: number; code: string; ok: boolean; result?: any; error?: string; ms: number; client_id?: string; user_id: number | null; }
export interface ToolCallEntry { ts: number; tool: string; ok: boolean; ms: number; error?: string; user_id: number | null; client_id?: string; }

export class RobloxBridge {
  registry = new ClientRegistry();
  private wss: WebSocketServer;
  private logBuffer: LogEntry[] = [];
  private readonly maxLogs = 1000;
  private snapshots = new Map<string, { rootPath: string; data: any[]; ts: number; user_id: number | null }>();
  private recordedScripts: RecordedScript[] = [];
  private readonly maxScripts = 300;
  private toolCalls: ToolCallEntry[] = [];
  private readonly maxToolCalls = 500;
  readonly requireAuth: boolean;

  constructor(private port: number, private host: string) {
    this.requireAuth = isDbConfigured();
    this.wss = new WebSocketServer({ port, host });
    this.wss.on("connection", (ws, req) => this.onConnect(ws, req?.socket?.remoteAddress));
    this.log("info", `[bridge] WS listening on ws://${host}:${port}${this.requireAuth ? " (auth required)" : " (local mode)"}`, null);
    this.startHeartbeat();
  }

  private startHeartbeat() {
    const PING_INTERVAL = 20_000;
    const interval = setInterval(() => {
      const now = Date.now();
      this.wss.clients.forEach((rawWs) => {
        const w = rawWs as any;
        if (w.isAlive === false) {
          const c = this.findClientByWs(rawWs as WebSocket);
          const cid = c ? c.client_id : "(pre-auth)";
          this.log("warn", `[bridge] client ${cid} unresponsive — terminating`, c?.user_id ?? null);
          try { (rawWs as WebSocket).terminate(); } catch {}
          return;
        }
        w.isAlive = false;
        try { (rawWs as WebSocket).ping(); } catch {}
      });
    }, PING_INTERVAL);
    this.wss.on("close", () => clearInterval(interval));
  }

  private findClientByWs(ws: WebSocket) {
    for (const c of this.registry.listAll()) if (c.ws === ws) return c;
    return undefined;
  }

  private async onConnect(ws: WebSocket, addr?: string) {
    const remote = maskIp(addr);
    this.log("info", `[bridge] incoming connection from ${remote}`, null);

    (ws as any).isAlive = true;
    ws.on("pong", () => { (ws as any).isAlive = true; });

    let authed = !this.requireAuth;
    let clientInfo: ClientInfo | null = null;

    if (!this.requireAuth) {
      const cid = randomUUID().slice(0, 16);
      clientInfo = this.registry.add({
        client_id: cid, user_id: null, api_key_id: null,
        roblox_user_id: null, roblox_user_name: null, place_id: null,
        device_type: "Unknown", executor: "Unknown",
        capabilities: {}, ip_masked: remote, ws, session_id: 0,
      });
      ws.send(JSON.stringify({ event: "auth_ok", client_id: cid, mode: "local" }));
    }

    ws.on("message", async (raw) => {
      (ws as any).isAlive = true;
      let msg: any;
      try { msg = JSON.parse(raw.toString()); }
      catch { this.log("error", `[bridge] bad JSON from ${remote}`, null); return; }
      if (msg.event === "ping") return;

      if (!authed) {
        if (msg.action !== "auth") {
          ws.send(JSON.stringify({ event: "auth_failed", error: "send {action:'auth', api_key:'...'} first" }));
          ws.close(4001, "auth required");
          return;
        }
        const resolved = await resolveApiKey(String(msg.api_key ?? "")).catch(() => null);
        if (!resolved) {
          ws.send(JSON.stringify({ event: "auth_failed", error: "invalid api_key" }));
          ws.close(4001, "invalid api_key");
          this.log("warn", `[bridge] auth FAILED from ${remote}`, null);
          return;
        }
        authed = true;
        const clientId = randomUUID().slice(0, 16);
        const sessionId = await recordSessionStart(
          resolved.user_id, resolved.api_key_id, clientId,
          typeof msg.roblox_user_id === "number" ? msg.roblox_user_id : null,
          typeof msg.roblox_user_name === "string" ? msg.roblox_user_name.slice(0, 100) : null,
          String(msg.device_type ?? "Unknown").slice(0, 40),
          String(msg.executor ?? "Unknown").slice(0, 60),
          msg.capabilities ?? {},
          remote,
        ).catch(() => 0);
        clientInfo = this.registry.add({
          client_id: clientId,
          user_id: resolved.user_id,
          api_key_id: resolved.api_key_id,
          roblox_user_id: typeof msg.roblox_user_id === "number" ? msg.roblox_user_id : null,
          roblox_user_name: typeof msg.roblox_user_name === "string" ? msg.roblox_user_name.slice(0, 100) : null,
          place_id: typeof msg.place_id === "number" ? msg.place_id : null,
          device_type: String(msg.device_type ?? "Unknown").slice(0, 40),
          executor: String(msg.executor ?? "Unknown").slice(0, 60),
          capabilities: msg.capabilities ?? {},
          ip_masked: remote, ws, session_id: sessionId,
        });
        ws.send(JSON.stringify({ event: "auth_ok", client_id: clientId, mode: "production" }));
        this.log("info", `[bridge] user ${resolved.user_id} client ${clientId} connected (${clientInfo.device_type} / ${clientInfo.executor}) from ${remote}`, resolved.user_id);
        return;
      }

      if (!clientInfo) return;

      if (msg.event === "log") {
        this.pushLog(msg.level ?? "info", String(msg.message ?? "").slice(0, 1000), clientInfo.user_id);
        return;
      }

      if (msg.id && clientInfo.pending.has(msg.id)) {
        const p = clientInfo.pending.get(msg.id)!;
        clearTimeout(p.timer);
        clientInfo.pending.delete(msg.id);
        if (msg.ok) p.resolve(msg.result);
        else p.reject(new Error(msg.error ?? "unknown roblox error"));
      }
    });

    ws.on("close", async () => {
      if (clientInfo) {
        for (const [, p] of clientInfo.pending) {
          clearTimeout(p.timer);
          try { p.reject(new Error("client disconnected")); } catch {}
        }
        clientInfo.pending.clear();
        this.registry.remove(clientInfo.client_id);
        if (clientInfo.session_id) await recordSessionEnd(clientInfo.session_id).catch(() => {});
        this.log("info", `[bridge] client ${clientInfo.client_id} disconnected`, clientInfo.user_id);
      }
    });

    ws.on("error", (err) => this.log("error", `[bridge] ws error: ${err.message}`, null));
  }

  async requestOnClient<T = any>(c: ClientInfo, action: string, payload: Record<string, any> = {}, timeoutMs = 10_000): Promise<T> {
    if (c.ws.readyState !== WebSocket.OPEN) throw new Error("client not connected");
    const id = randomUUID();
    const frame = JSON.stringify({ id, action, ...payload });
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        c.pending.delete(id);
        reject(new Error(`Request '${action}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      c.pending.set(id, { resolve, reject, timer });
      c.ws.send(frame);
    });
  }

  pushLog(level: string, message: string, userId: number | null) {
    this.logBuffer.push({ ts: Date.now(), level, message, user_id: userId });
    if (this.logBuffer.length > this.maxLogs) this.logBuffer.splice(0, this.logBuffer.length - this.maxLogs);
  }

  private log(level: string, message: string, userId: number | null) {
    process.stderr.write(`${message}\n`);
    this.pushLog(level, message, userId);
  }

  getLogs(userId: number | null, limit = 100, levelFilter?: string): LogEntry[] {
    let f = this.logBuffer;
    if (this.requireAuth) f = f.filter((l) => l.user_id === userId || l.user_id === null);
    if (levelFilter) f = f.filter((l) => l.level === levelFilter);
    return f.slice(-limit);
  }

  clearLogs(userId: number | null) {
    if (this.requireAuth) this.logBuffer = this.logBuffer.filter((l) => l.user_id !== userId && l.user_id !== null);
    else this.logBuffer = [];
  }

  storeSnapshot(rootPath: string, data: any[], userId: number | null): string {
    const id = randomUUID();
    this.snapshots.set(id, { rootPath, data, ts: Date.now(), user_id: userId });
    if (this.snapshots.size > 200) {
      const oldest = [...this.snapshots.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
      if (oldest) this.snapshots.delete(oldest[0]);
    }
    return id;
  }

  getSnapshot(id: string, userId: number | null) {
    const s = this.snapshots.get(id);
    if (!s) return undefined;
    if (this.requireAuth && s.user_id !== userId) return undefined;
    return s;
  }

  snapshotCount(userId: number | null): number {
    if (!this.requireAuth) return this.snapshots.size;
    let n = 0;
    for (const [, s] of this.snapshots) if (s.user_id === userId) n++;
    return n;
  }

  recordScript(code: string, ok: boolean, result: any, error: string | undefined, ms: number, clientId: string | undefined, userId: number | null) {
    this.recordedScripts.push({ ts: Date.now(), code, ok, result: ok ? result : undefined, error, ms, client_id: clientId, user_id: userId });
    if (this.recordedScripts.length > this.maxScripts) this.recordedScripts.shift();
  }

  getRecordedScripts(userId: number | null, limit: number): RecordedScript[] {
    let f = this.recordedScripts;
    if (this.requireAuth) f = f.filter((s) => s.user_id === userId);
    return f.slice(-limit);
  }

  logToolCall(tool: string, ok: boolean, ms: number, userId: number | null, clientId?: string, error?: string) {
    this.toolCalls.push({ ts: Date.now(), tool, ok, ms, error, user_id: userId, client_id: clientId });
    if (this.toolCalls.length > this.maxToolCalls) this.toolCalls.shift();
  }

  getToolCalls(userId: number | null, limit: number): ToolCallEntry[] {
    let f = this.toolCalls;
    if (this.requireAuth) f = f.filter((c) => c.user_id === userId);
    return f.slice(-limit);
  }
}
