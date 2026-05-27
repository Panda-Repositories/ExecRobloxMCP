import { z } from "zod";
import type { RobloxBridge } from "./bridge.js";

type ToolHandler = (args: any) => Promise<any>;

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: z.ZodObject<any>;
  handler: ToolHandler;
}

export function buildTools(bridge: RobloxBridge): ToolDef[] {
  return [
    {
      name: "execute_lua",
      description:
        "Execute raw Lua code in the Roblox client. Code runs in the executor's environment with full access. " +
        "Use 'return <value>' to send a value back. Returns JSON-serializable result or error.",
      inputSchema: z.object({
        code: z.string().describe("Lua source to execute. Use 'return X' to return X."),
        timeout_ms: z.number().int().positive().optional().describe("Max wait, default 10000."),
      }),
      handler: async ({ code, timeout_ms }) => {
        return await bridge.request("exec", { code }, timeout_ms ?? 10_000);
      },
    },

    {
      name: "get_players",
      description: "List all players in the current server with name, userId, team, health.",
      inputSchema: z.object({}),
      handler: async () => bridge.request("get_players"),
    },

    {
      name: "get_player_info",
      description: "Get detailed info about one player: position, health, character state, account info.",
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
        "AI vision substitute: returns a structured description of what's currently visible from the player's camera. " +
        "Includes camera state, on-screen players (with screen coords, distance, occlusion), and nearby parts. " +
        "Works on all executors, no image data.",
      inputSchema: z.object({
        max_distance: z.number().positive().optional().describe("Max distance to scan, default 200 studs"),
        max_parts: z.number().int().positive().optional().describe("Max parts to return, default 50"),
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
      description: "Check if the Roblox executor client is currently connected.",
      inputSchema: z.object({}),
      handler: async () => ({ connected: bridge.isConnected() }),
    },
  ];
}
