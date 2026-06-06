import { z } from "zod";
import type { RobloxBridge } from "./bridge.js";
import type { ClientInfo } from "./registry.js";

export interface ToolCtx {
  userId: number | null;
  bridge: RobloxBridge;
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: z.ZodObject<any>;
  handler: (args: any, ctx: ToolCtx) => Promise<any>;
}

function pick(ctx: ToolCtx, args: any): ClientInfo {
  return ctx.bridge.registry.resolveTarget(ctx.userId, args?.client_id);
}

const ClientIdArg = z.string().optional().describe("Target a specific client_id from list_my_clients. Optional if you only have one client connected.");

function diffSnapshots(prev: any[], curr: any[]) {
  const pm = new Map<string, any>(prev.map((e) => [e.path, e]));
  const cm = new Map<string, any>(curr.map((e) => [e.path, e]));
  const added: any[] = [], removed: any[] = [], moved: any[] = [], reclassed: any[] = [];
  for (const [path, e] of cm) {
    const p = pm.get(path);
    if (!p) { added.push(e); continue; }
    if (p.class !== e.class) reclassed.push({ path, from: p.class, to: e.class });
    if (e.position && p.position) {
      const dx = e.position.x - p.position.x, dy = e.position.y - p.position.y, dz = e.position.z - p.position.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d > 0.01) moved.push({ path, from: p.position, to: e.position, distance: d });
    }
  }
  for (const [path, e] of pm) if (!cm.has(path)) removed.push(e);
  return {
    added: { count: added.length, items: added.slice(0, 100) },
    removed: { count: removed.length, items: removed.slice(0, 100) },
    moved: { count: moved.length, items: moved.slice(0, 100) },
    reclassed: { count: reclassed.length, items: reclassed.slice(0, 100) },
  };
}

export function buildTools(): ToolDef[] {
  return [
    {
      name: "list_my_clients",
      description:
        "List every Roblox client currently connected with your API key. Each entry has a client_id you can pass to other tools to target that specific device. " +
        "Returns roblox username, device type (Desktop / Mobile / Console), executor name, capabilities (has_decompile, has_hookmetamethod, etc.), and status.",
      inputSchema: z.object({}),
      handler: async (_args, ctx) => {
        return ctx.bridge.registry.listByUser(ctx.userId).map((c) => ({
          client_id: c.client_id,
          roblox_user_id: c.roblox_user_id,
          roblox_user_name: c.roblox_user_name,
          place_id: c.place_id,
          device_type: c.device_type,
          executor: c.executor,
          status: c.status,
          capabilities: c.capabilities,
          connected_for_s: Math.floor((Date.now() - c.connected_at) / 1000),
        }));
      },
    },

    {
      name: "bridge_status",
      description: "Check connection state. Returns how many Roblox clients you have connected + recent tool call count + snapshot count.",
      inputSchema: z.object({}),
      handler: async (_args, ctx) => ({
        my_clients: ctx.bridge.registry.listByUser(ctx.userId).length,
        snapshots: ctx.bridge.snapshotCount(ctx.userId),
        recent_tool_calls: ctx.bridge.getToolCalls(ctx.userId, 50).length,
        auth_required: ctx.bridge.requireAuth,
      }),
    },

    {
      name: "execute_lua",
      description:
        "Execute raw Lua in a single connected Roblox client. Use 'return X' to send X back. " +
        "Every call is recorded — fetch history with get_recorded_scripts. " +
        "If you have multiple clients, specify client_id (see list_my_clients).",
      inputSchema: z.object({
        code: z.string().describe("Lua source to execute. Use 'return X' to return X."),
        client_id: ClientIdArg,
        timeout_ms: z.number().int().positive().optional().describe("Max wait, default 10000."),
      }),
      handler: async ({ code, client_id, timeout_ms }, ctx) => {
        const c = pick(ctx, { client_id });
        const t0 = Date.now();
        try {
          const r = await ctx.bridge.requestOnClient(c, "exec", { code }, timeout_ms ?? 10_000);
          ctx.bridge.recordScript(code, true, r, undefined, Date.now() - t0, c.client_id, ctx.userId);
          return r;
        } catch (e: any) {
          ctx.bridge.recordScript(code, false, null, String(e?.message ?? e), Date.now() - t0, c.client_id, ctx.userId);
          throw e;
        }
      },
    },

    {
      name: "execute_lua_on_all",
      description:
        "Run the same Lua on every connected client of yours (every device with your API key). " +
        "Returns a map of client_id → {ok, result|error}. Great for testing scripts across Desktop + Mobile + multiple sessions.",
      inputSchema: z.object({
        code: z.string(),
        timeout_ms: z.number().int().positive().optional(),
      }),
      handler: async ({ code, timeout_ms }, ctx) => {
        const clients = ctx.bridge.registry.listByUser(ctx.userId);
        if (clients.length === 0) throw new Error("no clients connected");
        const out: Record<string, any> = {};
        await Promise.all(clients.map(async (c) => {
          const t0 = Date.now();
          try {
            const r = await ctx.bridge.requestOnClient(c, "exec", { code }, timeout_ms ?? 10_000);
            ctx.bridge.recordScript(code, true, r, undefined, Date.now() - t0, c.client_id, ctx.userId);
            out[c.client_id] = { ok: true, device: c.device_type, executor: c.executor, result: r };
          } catch (e: any) {
            ctx.bridge.recordScript(code, false, null, String(e?.message ?? e), Date.now() - t0, c.client_id, ctx.userId);
            out[c.client_id] = { ok: false, device: c.device_type, executor: c.executor, error: String(e?.message ?? e) };
          }
        }));
        return out;
      },
    },

    {
      name: "dry_run_lua",
      description: "Compile-check Lua without executing. Returns {ok: true} or {ok: false, error}. Use before execute_lua on risky code.",
      inputSchema: z.object({ code: z.string(), client_id: ClientIdArg }),
      handler: async ({ code, client_id }, ctx) => ctx.bridge.requestOnClient(pick(ctx, { client_id }), "dry_run_lua", { code }),
    },

    {
      name: "get_recorded_scripts",
      description: "History of every execute_lua you've run: code, result, error, duration, target client.",
      inputSchema: z.object({ limit: z.number().int().positive().optional() }),
      handler: async ({ limit }, ctx) => ctx.bridge.getRecordedScripts(ctx.userId, limit ?? 50),
    },

    {
      name: "get_players",
      description: "List all players in the target client's server.",
      inputSchema: z.object({ client_id: ClientIdArg }),
      handler: async ({ client_id }, ctx) => ctx.bridge.requestOnClient(pick(ctx, { client_id }), "get_players"),
    },

    {
      name: "get_player_info",
      description: "Detailed info about one player: position, health, character state, account info, equipped tool.",
      inputSchema: z.object({ name: z.string(), client_id: ClientIdArg }),
      handler: async ({ name, client_id }, ctx) => ctx.bridge.requestOnClient(pick(ctx, { client_id }), "get_player_info", { name }),
    },

    {
      name: "teleport_player",
      description: "Teleport a player to coords or to another player. Usually only LocalPlayer is movable.",
      inputSchema: z.object({
        name: z.string(),
        x: z.number().optional(), y: z.number().optional(), z: z.number().optional(),
        to_player: z.string().optional(),
        client_id: ClientIdArg,
      }),
      handler: async (args, ctx) => ctx.bridge.requestOnClient(pick(ctx, args), "teleport_player", args),
    },

    {
      name: "kick_player",
      description: "Kick a player. Requires admin perms in the game.",
      inputSchema: z.object({ name: z.string(), reason: z.string().optional(), client_id: ClientIdArg }),
      handler: async (args, ctx) => ctx.bridge.requestOnClient(pick(ctx, args), "kick_player", args),
    },

    {
      name: "get_workspace_children",
      description: "List direct children of Workspace (or a sub-path).",
      inputSchema: z.object({
        path: z.string().optional(),
        max: z.number().int().positive().optional(),
        client_id: ClientIdArg,
      }),
      handler: async (args, ctx) => ctx.bridge.requestOnClient(pick(ctx, args), "get_workspace_children", args),
    },

    {
      name: "find_parts",
      description: "Search Workspace for parts by name substring / class.",
      inputSchema: z.object({
        name_match: z.string().optional(),
        class_name: z.string().optional(),
        max: z.number().int().positive().optional(),
        client_id: ClientIdArg,
      }),
      handler: async (args, ctx) => ctx.bridge.requestOnClient(pick(ctx, args), "find_parts", args),
    },

    {
      name: "query_instances",
      description: "Powerful search across the whole DataModel: name / class / IsA / attribute / scope. Returns paths + class + position.",
      inputSchema: z.object({
        root_path: z.string().optional().describe("From game, e.g. 'Workspace' or 'Players.LocalPlayer.PlayerScripts'."),
        name_match: z.string().optional(),
        class_name: z.string().optional(),
        is_a: z.string().optional(),
        has_attribute: z.string().optional(),
        max: z.number().int().positive().optional(),
        client_id: ClientIdArg,
      }),
      handler: async (args, ctx) => ctx.bridge.requestOnClient(pick(ctx, args), "query_instances", args),
    },

    {
      name: "spawn_part",
      description: "Spawn a Part in Workspace.",
      inputSchema: z.object({
        x: z.number(), y: z.number(), z: z.number(),
        size_x: z.number().optional(), size_y: z.number().optional(), size_z: z.number().optional(),
        color: z.string().optional(),
        anchored: z.boolean().optional(),
        name: z.string().optional(),
        client_id: ClientIdArg,
      }),
      handler: async (args, ctx) => ctx.bridge.requestOnClient(pick(ctx, args), "spawn_part", args),
    },

    {
      name: "destroy_instance",
      description: "Destroy an instance by full path or by name.",
      inputSchema: z.object({
        path: z.string().optional(),
        name: z.string().optional(),
        client_id: ClientIdArg,
      }),
      handler: async (args, ctx) => ctx.bridge.requestOnClient(pick(ctx, args), "destroy_instance", args),
    },

    {
      name: "decompile_script",
      description: "Decompile a LocalScript / ModuleScript / Script. Requires executor with decompile API.",
      inputSchema: z.object({
        path: z.string(),
        timeout_ms: z.number().int().positive().optional(),
        client_id: ClientIdArg,
      }),
      handler: async ({ path, timeout_ms, client_id }, ctx) =>
        ctx.bridge.requestOnClient(pick(ctx, { client_id }), "decompile_script", { path }, timeout_ms ?? 20_000),
    },

    {
      name: "list_remotes",
      description: "List every RemoteEvent / RemoteFunction / UnreliableRemoteEvent (and Bindables) in the DataModel.",
      inputSchema: z.object({
        root_path: z.string().optional(),
        include_bindables: z.boolean().optional(),
        max: z.number().int().positive().optional(),
        client_id: ClientIdArg,
      }),
      handler: async (args, ctx) => ctx.bridge.requestOnClient(pick(ctx, args), "list_remotes", args),
    },

    {
      name: "fire_remote",
      description: "Fire RemoteEvent (FireServer) or invoke RemoteFunction (InvokeServer) by path with args.",
      inputSchema: z.object({
        path: z.string(),
        args: z.array(z.any()).optional(),
        invoke: z.boolean().optional(),
        client_id: ClientIdArg,
      }),
      handler: async (args, ctx) => ctx.bridge.requestOnClient(pick(ctx, args), "fire_remote", args, 15_000),
    },

    {
      name: "start_remote_spy",
      description: "Begin capturing FireServer / InvokeServer / Bindable Fire calls via __namecall hook. Requires executor with hookmetamethod.",
      inputSchema: z.object({
        max_buffer: z.number().int().positive().optional(),
        client_id: ClientIdArg,
      }),
      handler: async (args, ctx) => ctx.bridge.requestOnClient(pick(ctx, args), "start_remote_spy", args),
    },

    {
      name: "stop_remote_spy",
      description: "Stop capturing remote calls.",
      inputSchema: z.object({ client_id: ClientIdArg }),
      handler: async (args, ctx) => ctx.bridge.requestOnClient(pick(ctx, args), "stop_remote_spy"),
    },

    {
      name: "get_remote_log",
      description: "Get recent remote calls captured by remote_spy.",
      inputSchema: z.object({
        limit: z.number().int().positive().optional(),
        path_match: z.string().optional(),
        client_id: ClientIdArg,
      }),
      handler: async (args, ctx) => ctx.bridge.requestOnClient(pick(ctx, args), "get_remote_log", args),
    },

    {
      name: "clear_remote_log",
      description: "Clear remote spy buffer.",
      inputSchema: z.object({ client_id: ClientIdArg }),
      handler: async (args, ctx) => ctx.bridge.requestOnClient(pick(ctx, args), "clear_remote_log"),
    },

    {
      name: "take_state_snapshot",
      description: "Snapshot all descendants under a path. Returns snapshot_id usable in diff_state_from.",
      inputSchema: z.object({
        root_path: z.string().optional(),
        max: z.number().int().positive().optional(),
        client_id: ClientIdArg,
      }),
      handler: async (args, ctx) => {
        const c = pick(ctx, args);
        const data = await ctx.bridge.requestOnClient<any[]>(c, "snapshot_state", args, 20_000);
        const id = ctx.bridge.storeSnapshot(args.root_path ?? "Workspace", data, ctx.userId);
        return { snapshot_id: id, count: data.length, root_path: args.root_path ?? "Workspace", from_client: c.client_id };
      },
    },

    {
      name: "diff_state_from",
      description: "Re-snapshot and diff vs a stored snapshot. Returns added / removed / moved / reclassed.",
      inputSchema: z.object({
        snapshot_id: z.string(),
        max: z.number().int().positive().optional(),
        client_id: ClientIdArg,
      }),
      handler: async ({ snapshot_id, max, client_id }, ctx) => {
        const prev = ctx.bridge.getSnapshot(snapshot_id, ctx.userId);
        if (!prev) throw new Error("snapshot_id not found (or not yours; max 200 retained)");
        const c = pick(ctx, { client_id });
        const current = await ctx.bridge.requestOnClient<any[]>(c, "snapshot_state", { root_path: prev.rootPath, max }, 20_000);
        return {
          root_path: prev.rootPath,
          previous_count: prev.data.length,
          current_count: current.length,
          ...diffSnapshots(prev.data, current),
        };
      },
    },

    {
      name: "get_dev_console_logs",
      description: "Get recent developer console logs from Roblox (print/warn/error). Scoped to your clients.",
      inputSchema: z.object({
        limit: z.number().int().positive().optional(),
        level: z.enum(["info", "warn", "error"]).optional(),
      }),
      handler: async ({ limit, level }, ctx) => ctx.bridge.getLogs(ctx.userId, limit ?? 100, level),
    },

    {
      name: "clear_dev_console_logs",
      description: "Clear your captured log buffer.",
      inputSchema: z.object({}),
      handler: async (_args, ctx) => { ctx.bridge.clearLogs(ctx.userId); return { ok: true }; },
    },

    {
      name: "describe_view",
      description: "AI vision substitute: camera, on-screen players (coords/distance/team/tool), nearby parts, visible UI text. Works on every executor.",
      inputSchema: z.object({
        max_distance: z.number().positive().optional(),
        max_parts: z.number().int().positive().optional(),
        include_ui: z.boolean().optional(),
        client_id: ClientIdArg,
      }),
      handler: async (args, ctx) => ctx.bridge.requestOnClient(pick(ctx, args), "describe_view", args),
    },

    {
      name: "capture_screenshot",
      description: "Viewport screenshot via CaptureService. Returns base64 PNG if executor supports it; else content ID only.",
      inputSchema: z.object({ client_id: ClientIdArg }),
      handler: async (args, ctx) => ctx.bridge.requestOnClient(pick(ctx, args), "capture_screenshot", {}, 15_000),
    },

    {
      name: "get_anti_afk_status",
      description:
        "Check the Roblox 20-minute idle-kick guard on a client. Returns whether it's enabled + available, how many times it has fired this session, and when it last fired. " +
        "The guard hooks LocalPlayer.Idled and uses VirtualUser to simulate input — same trick every modern executor uses.",
      inputSchema: z.object({ client_id: ClientIdArg }),
      handler: async (args, ctx) => ctx.bridge.requestOnClient(pick(ctx, args), "get_anti_afk_status"),
    },

    {
      name: "set_anti_afk",
      description: "Turn the anti-AFK guard on or off on a client at runtime. Default is on (controlled by Anti_AFK at the top of client.lua).",
      inputSchema: z.object({
        enabled: z.boolean(),
        client_id: ClientIdArg,
      }),
      handler: async (args, ctx) => ctx.bridge.requestOnClient(pick(ctx, args), "set_anti_afk", { enabled: args.enabled }),
    },
  ];
}
