import { z } from "zod";
import type { RobloxBridge } from "./bridge.js";

type ToolHandler = (args: any) => Promise<any>;

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: z.ZodObject<any>;
  handler: ToolHandler;
}

function diffSnapshots(prev: any[], curr: any[]) {
  const prevMap = new Map<string, any>(prev.map((e) => [e.path, e]));
  const currMap = new Map<string, any>(curr.map((e) => [e.path, e]));
  const added: any[] = [];
  const removed: any[] = [];
  const moved: any[] = [];
  const reclassed: any[] = [];

  for (const [path, e] of currMap) {
    const p = prevMap.get(path);
    if (!p) {
      added.push(e);
    } else {
      if (p.class !== e.class) reclassed.push({ path, from: p.class, to: e.class });
      if (e.position && p.position) {
        const dx = (e.position.x ?? 0) - (p.position.x ?? 0);
        const dy = (e.position.y ?? 0) - (p.position.y ?? 0);
        const dz = (e.position.z ?? 0) - (p.position.z ?? 0);
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (dist > 0.01) {
          moved.push({ path, from: p.position, to: e.position, distance: dist });
        }
      }
    }
  }
  for (const [path, e] of prevMap) {
    if (!currMap.has(path)) removed.push(e);
  }

  return {
    added: { count: added.length, items: added.slice(0, 100) },
    removed: { count: removed.length, items: removed.slice(0, 100) },
    moved: { count: moved.length, items: moved.slice(0, 100) },
    reclassed: { count: reclassed.length, items: reclassed.slice(0, 100) },
  };
}

export function buildTools(bridge: RobloxBridge): ToolDef[] {
  return [
    {
      name: "execute_lua",
      description:
        "Execute raw Lua code in the Roblox client. Code runs in the executor's environment with full access. " +
        "Use 'return <value>' to send a value back. Returns JSON-serializable result or error. " +
        "Every call is recorded — use get_recorded_scripts to retrieve history.",
      inputSchema: z.object({
        code: z.string().describe("Lua source to execute. Use 'return X' to return X."),
        timeout_ms: z.number().int().positive().optional().describe("Max wait, default 10000."),
      }),
      handler: async ({ code, timeout_ms }) => {
        const t0 = Date.now();
        try {
          const result = await bridge.request("exec", { code }, timeout_ms ?? 10_000);
          bridge.recordScript(code, true, result, undefined, Date.now() - t0);
          return result;
        } catch (e: any) {
          bridge.recordScript(code, false, null, String(e?.message ?? e), Date.now() - t0);
          throw e;
        }
      },
    },

    {
      name: "dry_run_lua",
      description: "Compile-check Lua without executing. Returns {ok: true} or {ok: false, error: '...'}. Use this before execute_lua on risky code.",
      inputSchema: z.object({
        code: z.string(),
      }),
      handler: async ({ code }) => bridge.request("dry_run_lua", { code }),
    },

    {
      name: "get_recorded_scripts",
      description: "History of execute_lua calls in this server session: code, result, error, duration. Useful to recall working snippets.",
      inputSchema: z.object({
        limit: z.number().int().positive().optional().describe("Max entries, default 50, newest last"),
      }),
      handler: async ({ limit }) => bridge.getRecordedScripts(limit ?? 50),
    },

    {
      name: "get_players",
      description: "List all players in the current server with name, userId, team, health.",
      inputSchema: z.object({}),
      handler: async () => bridge.request("get_players"),
    },

    {
      name: "get_player_info",
      description: "Detailed info about one player: position, health, character state, account info, equipped tool.",
      inputSchema: z.object({
        name: z.string().describe("Player name or display name"),
      }),
      handler: async ({ name }) => bridge.request("get_player_info", { name }),
    },

    {
      name: "teleport_player",
      description:
        "Teleport a player's character to coordinates. If 'to_player' given, teleport to that player instead. " +
        "Requires the executor to have permission on the target (usually only local player).",
      inputSchema: z.object({
        name: z.string().describe("Player to move (often LocalPlayer)"),
        x: z.number().optional(),
        y: z.number().optional(),
        z: z.number().optional(),
        to_player: z.string().optional().describe("Teleport to this player instead of coords"),
      }),
      handler: async (args) => bridge.request("teleport_player", args),
    },

    {
      name: "kick_player",
      description: "Kick a player. Only works if executor has admin perms in the game.",
      inputSchema: z.object({
        name: z.string(),
        reason: z.string().optional(),
      }),
      handler: async (args) => bridge.request("kick_player", args),
    },

    {
      name: "get_workspace_children",
      description: "List direct children of Workspace (or a sub-path). Returns name, class, position if BasePart.",
      inputSchema: z.object({
        path: z.string().optional().describe("Dot path under Workspace, e.g. 'Map.Buildings'. Empty = Workspace root."),
        max: z.number().int().positive().optional().describe("Max children to return, default 100"),
      }),
      handler: async (args) => bridge.request("get_workspace_children", args),
    },

    {
      name: "find_parts",
      description: "Search Workspace for parts matching name/class. Returns up to 'max' matches with paths and positions.",
      inputSchema: z.object({
        name_match: z.string().optional().describe("Substring of instance name"),
        class_name: z.string().optional().describe("Exact ClassName, e.g. 'Part', 'MeshPart'"),
        max: z.number().int().positive().optional(),
      }),
      handler: async (args) => bridge.request("find_parts", args),
    },

    {
      name: "query_instances",
      description:
        "Powerful search over the entire DataModel (not just Workspace). Combine filters: name substring, exact ClassName, IsA() class (includes subclasses), attribute presence, custom scope path. Returns paths + classes + positions.",
      inputSchema: z.object({
        root_path: z.string().optional().describe("Search root from game, e.g. 'Workspace', 'Players.LocalPlayer.PlayerScripts'. Default: game (entire DataModel)"),
        name_match: z.string().optional().describe("Case-insensitive substring of instance name"),
        class_name: z.string().optional().describe("Exact ClassName match"),
        is_a: z.string().optional().describe("Match :IsA(class) — catches subclasses (e.g. is_a='BasePart' matches Part, MeshPart, etc.)"),
        has_attribute: z.string().optional().describe("Only return instances that have an attribute with this name"),
        max: z.number().int().positive().optional().describe("Max results, default 100"),
      }),
      handler: async (args) => bridge.request("query_instances", args),
    },

    {
      name: "spawn_part",
      description: "Spawn a Part in Workspace at given position with optional size/color/anchor.",
      inputSchema: z.object({
        x: z.number(),
        y: z.number(),
        z: z.number(),
        size_x: z.number().optional(),
        size_y: z.number().optional(),
        size_z: z.number().optional(),
        color: z.string().optional().describe("Hex like #ff0000 or BrickColor name"),
        anchored: z.boolean().optional(),
        name: z.string().optional(),
      }),
      handler: async (args) => bridge.request("spawn_part", args),
    },

    {
      name: "destroy_instance",
      description: "Destroy an instance by full path (e.g. 'Workspace.Part1') or by name search.",
      inputSchema: z.object({
        path: z.string().optional(),
        name: z.string().optional(),
      }),
      handler: async (args) => bridge.request("destroy_instance", args),
    },

    {
      name: "decompile_script",
      description:
        "Decompile a LocalScript / ModuleScript / Script by path. Returns Lua source. " +
        "Requires the executor to expose a `decompile` function (Solara, Synapse, Wave, Krnl all have it). " +
        "Use query_instances with class_name='LocalScript' or 'ModuleScript' to find targets.",
      inputSchema: z.object({
        path: z.string().describe("Full dot path from game, e.g. 'Players.LocalPlayer.PlayerScripts.CombatHandler'"),
        timeout_ms: z.number().int().positive().optional(),
      }),
      handler: async ({ path, timeout_ms }) => bridge.request("decompile_script", { path }, timeout_ms ?? 20_000),
    },

    {
      name: "list_remotes",
      description:
        "List every RemoteEvent / RemoteFunction / UnreliableRemoteEvent (and BindableEvent/BindableFunction if asked) in the DataModel. Returns name + class + path. Pair with fire_remote or start_remote_spy.",
      inputSchema: z.object({
        root_path: z.string().optional().describe("Search root, default = game"),
        include_bindables: z.boolean().optional().describe("Include BindableEvent/BindableFunction (default true)"),
        max: z.number().int().positive().optional().describe("Max results, default 500"),
      }),
      handler: async (args) => bridge.request("list_remotes", args),
    },

    {
      name: "fire_remote",
      description:
        "Fire a RemoteEvent or invoke a RemoteFunction by path. " +
        "For RemoteEvent: invoke=false (default) → FireServer. " +
        "For RemoteFunction: invoke=true → InvokeServer and return the response. " +
        "Args are passed as JSON; primitives + tables only (Instance refs not supported).",
      inputSchema: z.object({
        path: z.string().describe("Full dot path to the remote"),
        args: z.array(z.any()).optional().describe("Arguments to pass (JSON-serializable)"),
        invoke: z.boolean().optional().describe("True = InvokeServer (wait for response). Default false = FireServer."),
      }),
      handler: async (args) => bridge.request("fire_remote", args, 15_000),
    },

    {
      name: "start_remote_spy",
      description:
        "Begin capturing all RemoteEvent:FireServer / RemoteFunction:InvokeServer / Bindable Fire calls via __namecall metatable hook. " +
        "Use get_remote_log to inspect captured calls. Requires executor with hookmetamethod + getrawmetatable + newcclosure (most do).",
      inputSchema: z.object({
        max_buffer: z.number().int().positive().optional().describe("Ring buffer size, default 200"),
      }),
      handler: async (args) => bridge.request("start_remote_spy", args),
    },

    {
      name: "stop_remote_spy",
      description: "Stop capturing remote calls. Note: the __namecall hook is left in place but neutralized; calls are silently ignored until restarted.",
      inputSchema: z.object({}),
      handler: async () => bridge.request("stop_remote_spy"),
    },

    {
      name: "get_remote_log",
      description: "Get recent remote calls captured by remote_spy. Each entry has timestamp, remote path, method, args (flattened — Instances become {__type, path, class}).",
      inputSchema: z.object({
        limit: z.number().int().positive().optional().describe("Max entries, default 100"),
        path_match: z.string().optional().describe("Filter entries whose remote path contains this substring (case-insensitive)"),
      }),
      handler: async (args) => bridge.request("get_remote_log", args),
    },

    {
      name: "clear_remote_log",
      description: "Clear the remote spy buffer.",
      inputSchema: z.object({}),
      handler: async () => bridge.request("clear_remote_log"),
    },

    {
      name: "take_state_snapshot",
      description:
        "Capture a flat snapshot of all descendants under a path: each entry is {path, class, name, position?}. " +
        "Returns a snapshot_id you can pass to diff_state_from later to detect what changed.",
      inputSchema: z.object({
        root_path: z.string().optional().describe("Root to snapshot, default 'Workspace'"),
        max: z.number().int().positive().optional().describe("Max instances, default 2000"),
      }),
      handler: async (args) => {
        const data = await bridge.request<any[]>("snapshot_state", args, 20_000);
        const id = bridge.storeSnapshot(args.root_path ?? "Workspace", data);
        return { snapshot_id: id, count: data.length, root_path: args.root_path ?? "Workspace" };
      },
    },

    {
      name: "diff_state_from",
      description:
        "Re-snapshot the same root as a stored snapshot and return what changed: added, removed, moved (>0.01 stud), reclassed. " +
        "Use this to detect events without polling individual properties.",
      inputSchema: z.object({
        snapshot_id: z.string(),
        max: z.number().int().positive().optional(),
      }),
      handler: async ({ snapshot_id, max }) => {
        const prev = bridge.getSnapshot(snapshot_id);
        if (!prev) throw new Error("snapshot_id not found (max 50 snapshots retained)");
        const current = await bridge.request<any[]>("snapshot_state", { root_path: prev.rootPath, max }, 20_000);
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
      description:
        "Get recent developer console logs captured from the Roblox client via LogService. " +
        "Includes print/warn/error output from the game and exploit script.",
      inputSchema: z.object({
        limit: z.number().int().positive().optional().describe("Max entries to return, default 100"),
        level: z.enum(["info", "warn", "error"]).optional().describe("Filter by level"),
      }),
      handler: async ({ limit, level }) => {
        return bridge.getLogs(limit ?? 100, level);
      },
    },

    {
      name: "clear_dev_console_logs",
      description: "Clear the captured log buffer.",
      inputSchema: z.object({}),
      handler: async () => {
        bridge.clearLogs();
        return { ok: true };
      },
    },

    {
      name: "describe_view",
      description:
        "AI vision substitute: structured description of what's currently visible from the player's camera. " +
        "Includes camera state, on-screen players (screen coords, distance, occlusion, tool equipped, team), nearby parts, and visible UI text. " +
        "Works on every executor, no image data needed.",
      inputSchema: z.object({
        max_distance: z.number().positive().optional().describe("Max distance to scan, default 200 studs"),
        max_parts: z.number().int().positive().optional().describe("Max parts to return, default 50"),
        include_ui: z.boolean().optional().describe("Include visible UI text from PlayerGui (default true)"),
      }),
      handler: async (args) => bridge.request("describe_view", args),
    },

    {
      name: "capture_screenshot",
      description:
        "Capture a viewport screenshot via CaptureService. Returns base64 PNG when executor supports asset reading " +
        "(getsynasset / getcustomasset + writefile), otherwise returns just the contentId. Best paired with describe_view.",
      inputSchema: z.object({}),
      handler: async () => bridge.request("capture_screenshot", {}, 15_000),
    },

    {
      name: "bridge_status",
      description: "Check if the Roblox executor client is currently connected. Also reports snapshot count and recent tool-call count.",
      inputSchema: z.object({}),
      handler: async () => ({
        connected: bridge.isConnected(),
        snapshots: bridge.snapshotCount(),
        recent_tool_calls: bridge.getToolCalls(10).length,
      }),
    },
  ];
}
