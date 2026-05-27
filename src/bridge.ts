import { WebSocketServer, WebSocket } from "ws";
import { randomUUID } from "node:crypto";

export interface LogEntry {
  ts: number;
  level: string;
  message: string;
}

interface PendingReq {
  resolve: (value: any) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export class RobloxBridge {
  private wss: WebSocketServer;
  private client: WebSocket | null = null;
  private pending = new Map<string, PendingReq>();
  private logBuffer: LogEntry[] = [];
  private readonly maxLogs = 500;

  constructor(private port: number) {
    this.wss = new WebSocketServer({ port });
    this.wss.on("connection", (ws, req) => this.onConnect(ws, req?.socket?.remoteAddress));
    this.log("info", `[bridge] WS listening on ws://0.0.0.0:${port}`);
  }

  private onConnect(ws: WebSocket, addr?: string) {
    const remote = addr ?? "unknown";
    this.log("info", `[bridge] incoming connection from ${remote}`);
    this.promoteClient(ws);

    ws.on("message", (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        this.log("error", `[bridge] bad JSON: ${raw.toString().slice(0, 200)}`);
        return;
      }

      if (msg.event === "log") {
        this.pushLog(msg.level ?? "info", String(msg.message ?? ""));
        return;
      }

      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        clearTimeout(p.timer);
        this.pending.delete(msg.id);
        if (msg.ok) p.resolve(msg.result);
        else p.reject(new Error(msg.error ?? "unknown roblox error"));
      }
    });

    ws.on("close", () => {
      if (this.client === ws) {
        this.client = null;
        this.rejectAllPending("client disconnected");
        this.log("info", `[bridge] ${remote} disconnected`);
      }
    });

    ws.on("error", (err) => {
      this.log("error", `[bridge] ws error: ${err.message}`);
    });
  }

  private promoteClient(ws: WebSocket) {
    if (this.client && this.client !== ws && this.client.readyState === WebSocket.OPEN) {
      this.log("warn", "[bridge] replacing existing client");
      this.client.close(4000, "replaced");
    }
    this.client = ws;
  }

  private rejectAllPending(reason: string) {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    this.pending.clear();
  }

  isConnected(): boolean {
    return this.client !== null && this.client.readyState === WebSocket.OPEN;
  }

  async request<T = any>(action: string, payload: Record<string, any> = {}, timeoutMs = 10_000): Promise<T> {
    if (!this.isConnected()) {
      throw new Error("Roblox client not connected. Run the Lua client in your executor first.");
    }
    const id = randomUUID();
    const frame = JSON.stringify({ id, action, ...payload });

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request '${action}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.client!.send(frame);
    });
  }

  pushLog(level: string, message: string) {
    this.logBuffer.push({ ts: Date.now(), level, message });
    if (this.logBuffer.length > this.maxLogs) {
      this.logBuffer.splice(0, this.logBuffer.length - this.maxLogs);
    }
  }

  private log(level: string, message: string) {
    process.stderr.write(`${message}\n`);
    this.pushLog(level, message);
  }

  getLogs(limit = 100, levelFilter?: string): LogEntry[] {
    const filtered = levelFilter
      ? this.logBuffer.filter((l) => l.level === levelFilter)
      : this.logBuffer;
    return filtered.slice(-limit);
  }

  clearLogs() {
    this.logBuffer = [];
  }
}
