# RobloxMCP

> Control Roblox from any MCP-compatible AI (Claude, Gemini, Cursor, Continue) through your exploit executor's WebSocket.

---

## What's new — v0.3.0

| Area | Update |
|---|---|
| **Production server** | Optional MySQL-backed mode with email/password accounts, per-user API keys (create / revoke / label), masked-IP login history. Local mode still default — flip on with `DB_HOST` env. |
| **Multi-client per API key** | Connect Desktop + Mobile + multiple sessions with the same key. AI sees each as a row: `Roblox ID · Device · Executor · Status`. Every tool takes optional `client_id` to target a specific device; `execute_lua_on_all` broadcasts to every device. |
| **Anti-AFK** | Built-in 20-min idle-kick guard via `LocalPlayer.Idled` + `VirtualUser:ClickButton2`. On by default. Tools `get_anti_afk_status` + `set_anti_afk` for runtime control. |
| **Mobile / low-UNC executor support** | Delta Android, Arceus X, Hydrogen, etc. Auto-detects device type (Desktop / Mobile / Tablet / Console / VR) and executor. Capability probe on connect — tools that need `hookmetamethod` / `decompile` return clear "not available on this executor" instead of crashing. |
| **Status pill UI** | Bottom-right dark pill in your Roblox game showing connection state. Green = connected, Yellow = reconnecting, Red = error. Slides in, animates the dot on reconnect. Mobile-safe via `gethui` / CoreGui / PlayerGui fallbacks. |
| **Client config flags** | `Client_API` (paste API key), `Keep_Reconnecting` (false = give up after first drop), `Anti_AFK` (toggle AFK guard) — all at the top of [roblox/client.lua](roblox/client.lua). |
| **Dashboard rebuild** | `/` route now has a login/register modal, "connected clients" table, per-user tool log, login history, recent sessions. Dark theme, responsive on mobile. |
| **Auth on MCP HTTP** | `Authorization: Bearer <key>` header or `?api_key=<key>` query — both supported. Each request is scoped to that user's clients only. |
| **27 tools total** (was 14 in v0.1) | New: `list_my_clients`, `execute_lua_on_all`, `get_anti_afk_status`, `set_anti_afk`, `decompile_script`, `query_instances`, `list_remotes`, `fire_remote`, `start_remote_spy` / `stop` / `get_remote_log` / `clear`, `dry_run_lua`, `get_recorded_scripts`, `take_state_snapshot`, `diff_state_from`. |
| **Multi-port auto-discovery** | Lua client tries `ws://localhost:8765`, `:8767`, and the `127.0.0.1` variants in order. No more port-mismatch headaches. |
| **Live demo** | See videos + screenshots below — Claude Code writing an ESP over every entity in the game, unedited. |

---

## Introduction

**RobloxMCP** bridges an [MCP](https://modelcontextprotocol.io) server to a running Roblox client via WebSocket. The Roblox side is a single Lua script you run inside an executor (Solara, Potassium, Synapse, etc). Once the script connects back to the local MCP server, your AI assistant can read game state, run arbitrary Lua, see what's on screen, and drive the player — all through a stable tool interface.

```
AI (Gemini / Claude / Cursor) <--stdio or HTTP--> MCP Server <--WebSocket--> Roblox Executor
```

The AI gets a clean tool API. The executor handles every privileged action. The MCP server just routes.

---

## Core Features

### Code & state
- **`execute_lua`** — run arbitrary Lua in the executor environment. Full power. Every call is auto-recorded.
- **`dry_run_lua`** — compile-check Lua without running. Catch syntax errors before execution.
- **`get_recorded_scripts`** — replay history of every `execute_lua` call (code, result, error, duration). The AI builds its own snippet library.
- **`decompile_script`** — pull Lua source from any LocalScript / ModuleScript / Script. Uses the executor's `decompile` API.

### Vision (the moat)
- **`describe_view`** — AI vision substitute: camera state, on-screen players (screen coords + distance + occlusion + team + tool equipped + health), nearby parts sorted by distance, **visible UI text** with absolute screen positions. Works on every executor, no image data.
- **`capture_screenshot`** — viewport → base64 PNG via `CaptureService`. Image content block returned so vision-capable models (Gemini, Claude) see it directly. Falls back to content ID when executor lacks file APIs.

### Players & world
- Player tools — `get_players`, `get_player_info`, `teleport_player`, `kick_player`.
- World tools — `get_workspace_children`, `find_parts`, `spawn_part`, `destroy_instance`.
- **`query_instances`** — search the entire DataModel with name/class/IsA/attribute filters. Way more flexible than `find_parts`.

### Remotes (the RemoteSpy moat)
- **`list_remotes`** — every RemoteEvent / RemoteFunction / UnreliableRemoteEvent / Bindable in the DataModel.
- **`fire_remote`** — FireServer or InvokeServer any remote by path with arbitrary args.
- **`start_remote_spy` / `stop_remote_spy` / `get_remote_log` / `clear_remote_log`** — hook `__namecall` via `hookmetamethod`, log every fired/invoked remote with flattened args (Instances become `{__type, path, class}`). Works on any exec with `getrawmetatable + hookmetamethod + newcclosure`.

### Diffing & dev console
- **`take_state_snapshot` / `diff_state_from`** — capture flat instance snapshots, diff later: added / removed / moved (>0.01 stud) / reclassed. AI detects events without polling.
- **`get_dev_console_logs` / `clear_dev_console_logs`** — every `print` / `warn` / `error` from the game and script is mirrored to a ring buffer. AI reads its own errors and self-corrects.

### Anti-AFK
- **20-minute idle-kick guard built in.** Hooks `LocalPlayer.Idled` and uses `VirtualUser:ClickButton2()` to fake input. Toggle at runtime via `set_anti_afk`. Check status / trigger count via `get_anti_afk_status`. Disable per device by setting `Anti_AFK = false` at the top of [roblox/client.lua](roblox/client.lua).

### Multi-client (Desktop + Mobile + multiple sessions, same API key)
- **`list_my_clients`** — every Roblox client connected with your API key. Returns roblox username, Device (Desktop / Mobile / Tablet / Console / VR), Executor, capabilities, status.
- Every other tool accepts an optional `client_id` to target a specific device. AI can prompt *"run this on my Delta Android"* or *"test on all clients"*.
- **`execute_lua_on_all`** — broadcast Lua to every device with your key at once. Returns per-client results so the AI can compare behavior across executors.

### Production / auth
- **Register & Login** with email + password. Each user gets a default 64-char API key, can create more, revoke any.
- **MySQL-backed** users, api_keys, login_history (with masked IPs), client_sessions.
- **Local mode** — if no `DB_HOST` env var, the server runs auth-free single-client (back to v0.2 behavior). Drop a `DB_HOST` in to flip on production mode.
- **Masked IPs** — last octet of IPv4 / last 2 segments of IPv6 stripped in storage. `localhost` and `::1` stored as `localhost`.

### Infra
- **HTTP transport** — persistent Node server, survives AI-client restarts. Stdio transport also supported.
- **Live dashboard** — `/` route. Login + register form, per-user view of connected clients (Roblox ID / Device / Executor / Status table), tool-call log, login history, recent sessions.
- **Auto-reconnect** — Lua client reconnects with exponential backoff. `Keep_Reconnecting` flag to disable. Bottom-right status pill (dark, animated, Green/Yellow/Red).
- **Mobile + low-UNC executor support** — Delta Android, low-UNC Wave variants, etc. Graceful capability degradation: tools that need `hookmetamethod` / `decompile` return a clear "not available on this executor" error instead of crashing.

---

## Demo

Live, unedited captures of Claude Code driving Roblox through RobloxMCP.

### Walkthrough video

<video src="media/demo-full.mp4" controls width="720"></video>

> If the player doesn't render on your browser, [download / open `media/demo-full.mp4`](media/demo-full.mp4) directly.

### Quick clip

<video src="media/demo-quick.mp4" controls width="720"></video>

> Direct link: [media/demo-quick.mp4](media/demo-quick.mp4).

### Screenshots

**`execute_lua` — printing "Hello, World!" from the AI side:**

![execute_lua hello world](media/01-hello-world.png)

**AI builds an ESP over every entity in the game on request:**

![AI-built ESP highlighting all entities](media/02-esp-demo.png)

---

## Requirements

- **Node.js** 18+ (for the MCP server)
- **npm**
- A **Roblox executor** with WebSocket support (see list below)
- An MCP-compatible AI client (Claude Desktop, Gemini CLI, Cursor, Continue, etc)
- **MySQL or MariaDB 5.7+** *(production mode only — local mode runs without a DB)*

---

## Supported Executors

Any executor that exposes a WebSocket client API. Tested / known-good shims included:

### Desktop
- **Solara** ✅ (full features)
- **Potassium** ✅ (full features)
- **Synapse X** (`syn.websocket.connect`) ✅
- **Krnl** (`Krnl.WebSocket.connect`) ✅
- **Wave / Velocity / Fluxus / Trigon** — anything exposing global `WebSocket.connect` ✅

### Mobile / low-UNC
- **Delta Android** ✅ (basic tools; no decompile, no remote spy if `hookmetamethod` missing)
- **Arceus X / Hydrogen** ✅ (basic tools)
- Other mobile / low-UNC executors that have `WebSocket.connect` → basic tools work, advanced tools (decompile, remote spy) gracefully report "not available"

The Lua client probes capabilities on connect and reports them to the server. The dashboard and `list_my_clients` show exactly what each device can do.

For full screenshot-to-base64 support the executor also needs `writefile` + `readfile` + `isfile`. Without those, `capture_screenshot` returns just the content ID and `describe_view` still works as the vision path.

---

## How to Run

Three windows total: your **server terminal**, your **AI client**, your **Roblox + executor**. Once set up, daily use = just launch the server.

There are two modes:

| Mode | When | Auth | Multi-user | DB |
|---|---|---|---|---|
| **Local** | dev / single user / localhost | none | no (single client) | not needed |
| **Production** | shared server / VPS / public | API key required | yes | MySQL or MariaDB |

Local mode is the default. Set `DB_HOST` to flip on production mode.

### One-time setup (local mode)

```powershell
cd RobloxMCP
npm install
npm run build
```

That's it. Skip the next "production setup" section if you're only running local.

### One-time setup (production mode)

1. Install MySQL or MariaDB. On Windows: download MariaDB MSI from mariadb.org, set a root password during install.

2. Create env vars (PowerShell, per session — or put in a `.env` loader of your choice):
   ```powershell
   $env:DB_HOST = "localhost"
   $env:DB_PORT = "3306"
   $env:DB_USER = "root"
   $env:DB_PASS = "yourpassword"
   $env:DB_NAME = "robloxmcp"
   ```

3. Create the schema:
   ```powershell
   npm install
   npm run db:setup
   ```

   This creates the `robloxmcp` database and the `users`, `api_keys`, `login_history`, `client_sessions` tables.

4. Build:
   ```powershell
   npm run build
   ```

5. On a VPS, point a reverse proxy (nginx, Caddy) at the server's HTTP port for TLS. The server itself binds `0.0.0.0` by default — adjust `MCP_HTTP_HOST` and `ROBLOX_WS_HOST` env vars to restrict.

### Every time you want to use it

**1. Start the server** (in its own PowerShell window — keep it open):

Local mode:
```powershell
cd "C:\path\to\ExecRobloxMCP"
node dist/index.js --http
```

Production mode (same command, with env vars from setup step 2 still set):
```powershell
cd "C:\path\to\ExecRobloxMCP"
node dist/index.js --http
```

The first log line tells you which mode you're in:
- `[RobloxMCP] mode: local (no auth)`
- `[RobloxMCP] mode: production (auth required)`

You should see:

```
[bridge] WS listening on ws://0.0.0.0:8765
[RobloxMCP] HTTP MCP at http://127.0.0.1:8766/mcp (WS bridge port: 8765)
```

Want different ports? Set `MCP_HTTP_PORT` and/or `ROBLOX_WS_PORT` before the command. The Lua client auto-tries ports **8765** and **8767** on both your `Server_IP` and `localhost` / `127.0.0.1`, so default and HTTP-mode setups both work. If you use a totally custom port, add it to `Server_WS_Ports` at the top of [roblox/client.lua](roblox/client.lua).

**Bindings (defaults):**
- HTTP MCP: `0.0.0.0:8766` — reachable from any LAN device. Override with `MCP_HTTP_HOST=127.0.0.1` to lock to localhost.
- WS bridge: `0.0.0.0:8765` — reachable from any LAN device. Override with `ROBLOX_WS_HOST=127.0.0.1`.

**Windows Firewall** — if it's on, allow incoming TCP on 8765 + 8766 once (PowerShell as Admin):
```powershell
New-NetFirewallRule -DisplayName "RobloxMCP WS"   -Direction Inbound -Protocol TCP -LocalPort 8765 -Action Allow
New-NetFirewallRule -DisplayName "RobloxMCP HTTP" -Direction Inbound -Protocol TCP -LocalPort 8766 -Action Allow
```

**1.5. Register & grab your API key** *(production mode only)*

Open the dashboard at `http://<server>:8766/` and click **Login / Register**. Sign up with email + password. You'll get back a 64-char API key. Save it — you'll paste it into both the AI client and the Lua. You can also:
- `curl -X POST http://<server>:8766/auth/register -H 'Content-Type: application/json' -d '{"email":"you@x.com","password":"hunter22hunter22"}'` → returns `{user_id, api_key}`
- `POST /auth/login` with same body → returns existing API keys
- `GET /auth/keys` (with `Authorization: Bearer <key>`) → list all your keys
- `POST /auth/keys` (with auth) → create another labeled key
- `DELETE /auth/keys/<id>` (with auth) → revoke

**2. Register with your AI client** (only the first time, or after a config wipe):

*Production mode:* append `?api_key=YOUR_KEY` to every URL below, or use the `Authorization: Bearer YOUR_KEY` header where the client supports it. Both work.

- **Claude Code** (CLI / VS Code):
  ```powershell
  claude mcp add roblox --scope user --transport http http://127.0.0.1:8766/mcp
  ```
  Then `/mcp` inside Claude Code to confirm `roblox · √ connected`.

- **Claude Desktop** — edit `%APPDATA%\Claude\claude_desktop_config.json`:
  ```json
  {
    "mcpServers": {
      "RobloxMCP": { "url": "http://127.0.0.1:8766/mcp" }
    }
  }
  ```
  Then fully quit + reopen Claude Desktop (system tray, not just the window).

- **Cursor** — Settings → MCP → Add new MCP server:
  ```json
  {
    "mcpServers": {
      "roblox": { "url": "http://127.0.0.1:8766/mcp" }
    }
  }
  ```
  (Or edit `~/.cursor/mcp.json` directly with the same content.) Restart Cursor.

- **Gemini CLI** — edit `~/.gemini/settings.json`:
  ```json
  {
    "mcpServers": {
      "roblox": { "httpUrl": "http://127.0.0.1:8766/mcp" }
    }
  }
  ```
  New shells of `gemini` pick it up automatically.

- **OpenAI Codex CLI** — edit `~/.codex/config.toml`:
  ```toml
  [mcp_servers.roblox]
  url = "http://127.0.0.1:8766/mcp"
  ```
  Restart `codex`.

- **Continue (VS Code / JetBrains)** — add to `~/.continue/config.json` under `experimental.modelContextProtocolServers`:
  ```json
  {
    "transport": { "type": "streamable-http", "url": "http://127.0.0.1:8766/mcp" }
  }
  ```
  Reload the IDE window.

- **Anything else MCP-compatible** — point it at `http://127.0.0.1:8766/mcp` using whichever HTTP transport key it expects (`url`, `httpUrl`, `endpoint`, etc.). If your client only speaks stdio, see *Advanced: stdio mode* at the bottom.

**3. Inject the Lua client** into Roblox:

1. Open [roblox/client.lua](roblox/client.lua). At the top:
   ```lua
   local Client_API = ""            -- paste your API key here (production mode only)
   local Keep_Reconnecting = true   -- false = give up after first disconnect
   local Anti_AFK = true            -- false to disable 20-min idle-kick guard
   local Server_IP = "10.168.0.100" -- PC LAN IP. "localhost" for same-PC executors. Mobile / MuMu / BlueStacks / LDPlayer = your PC's LAN IPv4.
   local Server_WS_Ports = { 8765, 8767 }
   ```
   - **Same PC** (running executor on your dev machine): set `Server_IP = "localhost"`.
   - **MuMu / BlueStacks / LDPlayer / Android emulator on same PC**: keep `Server_IP` as your LAN IPv4 (run `ipconfig` in PowerShell, look for `IPv4 Address` under your WiFi / Ethernet adapter).
   - **Physical phone on same WiFi**: same — use your PC's LAN IPv4. Both devices must be on the same network.
   - **VPS / remote server**: use the server's public IP or domain.
   The client tries `Server_IP` first, then falls back to `localhost`/`127.0.0.1`, so you can leave a LAN IP in even when running locally.
2. Join the Roblox experience you want to control.
3. Open your executor (Solara, Wave, Krnl, Delta Android, etc).
4. Paste the whole file and execute.

You should see two things:
- **Bottom-right of your Roblox screen**: a dark status pill. Green dot = connected, Yellow = reconnecting, Red = error. The label tells you which device + client_id the server gave you.
- **Roblox dev console (F9)** also prints `[mcp-bridge] client loaded · Mobile · Delta` and `[mcp-bridge] connected to ws://localhost:8765`.

The same API key can be used on multiple devices simultaneously. Connect Desktop + Mobile at the same time → both show up in `list_my_clients` and the dashboard, and the AI can target either by `client_id`.

Your **server terminal** will also print `[bridge] incoming connection from ::1`.

**4. Use it.** Ask your AI anything:

- *"List all players."*
- *"What can you see right now?"* (uses `describe_view`)
- *"Teleport me next to PlayerName."*
- *"Take a screenshot."*
- *"Run this Lua: `return Workspace:GetChildren()`"*
- *"Show me the last 50 dev console errors."*

### Dashboard

Open `http://127.0.0.1:8766/` in your browser. Auto-refreshing live view: Roblox connection state, every tool call with duration + status, snapshot count, uptime.

### Health check

In any shell: `curl http://127.0.0.1:8766/health` → `{"ok":true,"roblox_connected":true|false}`. Programmatic JSON via `/api/status` and recent tool calls via `/api/tool-log?limit=50`.

### Stopping it

- **Server:** Ctrl+C in the server terminal (or close the window).
- **Roblox side:** rejoin / re-execute / disconnect — server holds no persistent state.

### Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Server: `EADDRINUSE` | Another node already on 8765/8766 | Kill it: `Get-NetTCPConnection -LocalPort 8766 -State Listen \| %{ taskkill /F /PID $_.OwningProcess }` |
| AI client says "connection refused" | Server not running | Start the server (step 1) |
| `/mcp` shows roblox `× failed` | Server crashed or never started | Check the server terminal output |
| Tool call: "Roblox client not connected" | Lua not running in executor | Re-paste + execute [roblox/client.lua](roblox/client.lua) |
| Roblox console: `all ports failed: ... retry in Xs` | Server not running, or on a non-standard port | Start the server. If using a custom `ROBLOX_WS_PORT`, add that `ws://localhost:<port>` to `WS_URLS` in the Lua |
| Roblox console: `WebSocket timed out after Ns` | Lua reached a port with nothing listening | Server isn't up on that port — start it (default WS 8765) |

### Advanced: stdio mode

Skip step 1 entirely and let your AI client manage the server lifecycle:

```powershell
claude mcp add roblox node "C:\path\to\ExecRobloxMCP\dist\index.js" --scope user
```

Tradeoff: when Claude Code closes, the server dies and Roblox disconnects. HTTP mode (above) avoids that.

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
