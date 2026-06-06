import { WebSocket } from "ws";

export interface ClientPending {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export interface ClientInfo {
  client_id: string;
  user_id: number | null;
  api_key_id: number | null;
  roblox_user_id: number | null;
  roblox_user_name: string | null;
  place_id: number | null;
  device_type: string;
  executor: string;
  capabilities: Record<string, boolean>;
  ip_masked: string;
  connected_at: number;
  status: string;
  ws: WebSocket;
  session_id: number;
  pending: Map<string, ClientPending>;
}

export type NewClientInput = Omit<ClientInfo, "pending" | "connected_at" | "status">;

export class ClientRegistry {
  private byClientId = new Map<string, ClientInfo>();
  private byUserKey = new Map<string, Set<string>>();

  private userKey(userId: number | null): string {
    return userId == null ? "__local__" : String(userId);
  }

  add(info: NewClientInput): ClientInfo {
    const full: ClientInfo = { ...info, pending: new Map(), connected_at: Date.now(), status: "Ready" };
    this.byClientId.set(info.client_id, full);
    const k = this.userKey(info.user_id);
    if (!this.byUserKey.has(k)) this.byUserKey.set(k, new Set());
    this.byUserKey.get(k)!.add(info.client_id);
    return full;
  }

  remove(clientId: string): ClientInfo | undefined {
    const c = this.byClientId.get(clientId);
    if (!c) return;
    this.byClientId.delete(clientId);
    const k = this.userKey(c.user_id);
    const s = this.byUserKey.get(k);
    if (s) {
      s.delete(clientId);
      if (s.size === 0) this.byUserKey.delete(k);
    }
    return c;
  }

  get(clientId: string): ClientInfo | undefined {
    return this.byClientId.get(clientId);
  }

  listByUser(userId: number | null): ClientInfo[] {
    const ids = this.byUserKey.get(this.userKey(userId));
    if (!ids) return [];
    const out: ClientInfo[] = [];
    for (const id of ids) {
      const c = this.byClientId.get(id);
      if (c) out.push(c);
    }
    return out;
  }

  listAll(): ClientInfo[] {
    return [...this.byClientId.values()];
  }

  resolveTarget(userId: number | null, clientId?: string): ClientInfo {
    if (clientId) {
      const c = this.byClientId.get(clientId);
      if (!c) throw new Error(`client_id '${clientId}' not connected`);
      if (c.user_id !== userId) throw new Error("client_id not owned by this user");
      return c;
    }
    const list = this.listByUser(userId);
    if (list.length === 0) throw new Error("no Roblox clients connected (paste roblox/client.lua in your executor first)");
    if (list.length === 1) return list[0];
    const names = list.map((c) => `${c.client_id} (${c.device_type} / ${c.executor})`).join(", ");
    throw new Error(`multiple clients connected — specify client_id. Options: ${names}`);
  }

  setStatus(clientId: string, status: string) {
    const c = this.byClientId.get(clientId);
    if (c) c.status = status;
  }

  totalCount(): number { return this.byClientId.size; }
}
