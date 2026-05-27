# RobloxMCP

> Control Roblox from any MCP-compatible AI (Claude, Gemini, Cursor, Continue) through your exploit executor's WebSocket.

---

## Introduction

**RobloxMCP** bridges an [MCP](https://modelcontextprotocol.io) server to a running Roblox client via WebSocket. The Roblox side is a single Lua script you run inside an executor (Solara, Potassium, Synapse, etc). Once the script connects back to the local MCP server, your AI assistant can read game state, run arbitrary Lua, see what's on screen, and drive the player — all through a stable tool interface.

```
AI (Gemini / Claude / Cursor) <--stdio--> MCP Server <--WebSocket--> Roblox Executor
```

The AI gets a clean tool API. The executor handles every privileged action. The MCP server just routes.

---

## Core Features

- **`execute_lua`** — run arbitrary Lua in the executor environment. Full power.
- **Player tools** — list players, inspect, teleport, kick.
- **World tools** — list workspace, find parts by name/class, spawn parts, destroy instances.
- **`describe_view`** — AI vision substitute: camera state, on-screen players with screen coords + distance + occlusion check, nearby parts sorted by distance. Works on every executor.
- **`capture_screenshot`** — viewport → base64 PNG via `CaptureService`. Image content block returned so vision-capable models (Gemini, Claude) see it directly. Falls back to content ID when executor lacks file APIs.
- **Dev console capture** — all `print` / `warn` / `error` output from the game and the script is mirrored to a ring buffer. AI fetches with `get_dev_console_logs`.
- **Auto-reconnect** — Lua client reconnects with exponential backoff on drop.
- **Auth token** — set `ROBLOX_MCP_TOKEN` env so random clients can't hijack the bridge.

---

## Requirements

- **Node.js** 18+ (for the MCP server)
- **npm**
- A **Roblox executor** with WebSocket support (see list below)
- An MCP-compatible AI client (Claude Desktop, Gemini CLI, Cursor, Continue, etc)

---

## Supported Executors

Any executor that exposes a WebSocket client API. Tested / known-good shims included:

- **Solara** ✅
- **Potassium** ✅
- **Synapse X** (`syn.websocket.connect`) ✅
- **Krnl** (`Krnl.WebSocket.connect`) ✅
- **Wave / Velocity / Fluxus / Trigon** — anything exposing global `WebSocket.connect` ✅

For full screenshot-to-base64 support the executor also needs `writefile` + `readfile` + `isfile` (most modern ones do). Without those, `capture_screenshot` returns just the content ID and `describe_view` still works as the vision path.

---

## How to Run / Use

### 1. Install + build

```powershell
cd RobloxMCP
npm install
npm run build
```

### 2. Start the MCP server

```powershell
# optional but recommended: set an auth token
$env:ROBLOX_MCP_TOKEN = "your-secret-here"

node dist/index.js
```

The server stays on `stdio` for MCP and opens `ws://0.0.0.0:8765` for the Roblox bridge.

### 3. Configure your AI client

**Claude Desktop** — edit `%APPDATA%\Claude\claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "RobloxMCP": {
      "command": "node",
      "args": ["C:\\path\\to\\RobloxMCP\\dist\\index.js"],
      "env": { "ROBLOX_MCP_TOKEN": "your-secret-here" }
    }
  }
}
```

**Gemini CLI** — edit `~/.gemini/settings.json` with the same shape.

**Cursor / Continue / others** — point to `node` + the absolute path to `dist/index.js`.

### 4. Launch the Roblox client

1. Open `roblox/client.lua`.
2. If you set a token in step 2, paste the same value into `WS_TOKEN` near the top:
   ```lua
   local WS_TOKEN = "your-secret-here"
   ```
3. Join the Roblox experience you want to control.
4. Execute the script in your executor.

Console should print:
```
[mcp-bridge] connected to ws://localhost:8765
[mcp-bridge] auth ok
[mcp-bridge] handlers installed, ready for commands
```

### 5. Use it

Ask the AI things like:
- *"List all players."*
- *"Teleport me next to PlayerName."*
- *"What can you see right now?"* (uses `describe_view`)
- *"Take a screenshot."*
- *"Run this Lua: `return Workspace:GetChildren()`"*
- *"Show me the last 50 dev console errors."*

---

## Protocol (for hackers)

```
MCP → Roblox: {"id":"uuid","action":"...","...":...}
Roblox → MCP: {"id":"uuid","ok":true|false,"result"|"error":...}
Unsolicited:  {"event":"log","level":"info|warn|error","message":"..."}
```

Add a tool = add an entry in [src/tools.ts](src/tools.ts) plus a handler in `actions` inside [roblox/client.lua](roblox/client.lua). That's it.

---

## Credit

Made by **SkieHacker**.

If you fork, build on top, or include this in another project, keep the copyright line in `LICENSE`. That's the only string attached.

---

## License

MIT — see [LICENSE](LICENSE).

You can use, modify, distribute, and sell it. You only must preserve the copyright notice and the license text. Don't strip the credit.
