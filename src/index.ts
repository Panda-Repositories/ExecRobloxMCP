#!/usr/bin/env node
import "dotenv/config";
import http from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import { RobloxBridge } from "./bridge.js";
import { buildTools, ToolCtx } from "./tools.js";
import { isDbConfigured, dbHealth } from "./db.js";
import {
  registerUser, loginUser, resolveApiKey, listApiKeys, createApiKey,
  revokeApiKey, getLoginHistory, recentSessions, maskIp,
} from "./auth.js";

const WS_PORT = Number(process.env.ROBLOX_WS_PORT ?? 8765);
const WS_HOST = process.env.ROBLOX_WS_HOST ?? "0.0.0.0";

const HTTP_PORT_ENV = process.env.MCP_HTTP_PORT;
const useHttp = process.argv.includes("--http") || HTTP_PORT_ENV !== undefined;
const HTTP_PORT = Number(HTTP_PORT_ENV ?? 8766);
const HTTP_HOST = process.env.MCP_HTTP_HOST ?? "0.0.0.0";

const bridge = new RobloxBridge(WS_PORT, WS_HOST);
const tools = buildTools();
const toolMap = new Map(tools.map((t) => [t.name, t]));
const startTime = Date.now();

const AUTH_REQUIRED = isDbConfigured();

function buildServer(userId: number | null): Server {
  const server = new Server(
    { name: "RobloxMCP", version: "0.3.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: zodToJsonSchema(t.inputSchema as any, { $refStrategy: "none" }) as any,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = toolMap.get(req.params.name);
    const t0 = Date.now();
    if (!tool) {
      bridge.logToolCall(req.params.name, false, 0, userId, undefined, "unknown tool");
      return { isError: true, content: [{ type: "text", text: `Unknown tool: ${req.params.name}` }] };
    }
    try {
      const args = tool.inputSchema.parse(req.params.arguments ?? {});
      const ctx: ToolCtx = { userId, bridge };
      const result = await tool.handler(args, ctx);
      bridge.logToolCall(tool.name, true, Date.now() - t0, userId, args.client_id);

      if (result && typeof result === "object" && typeof (result as any).image_base64 === "string") {
        const r = result as any;
        const content: any[] = [
          { type: "image", data: r.image_base64, mimeType: r.mime_type ?? "image/png" },
        ];
        const meta = { ...r };
        delete meta.image_base64; delete meta.mime_type;
        if (Object.keys(meta).length > 0) content.push({ type: "text", text: JSON.stringify(meta, null, 2) });
        return { content };
      }

      return {
        content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result, null, 2) }],
      };
    } catch (err: any) {
      bridge.logToolCall(tool.name, false, Date.now() - t0, userId, undefined, String(err?.message ?? err));
      return { isError: true, content: [{ type: "text", text: `Error: ${err.message ?? String(err)}` }] };
    }
  });

  return server;
}

function readJsonBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve(undefined);
      try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

function clientIpFromReq(req: http.IncomingMessage): string {
  const fwd = (req.headers["x-forwarded-for"] as string) || "";
  if (fwd) return fwd.split(",")[0].trim();
  return req.socket.remoteAddress ?? "";
}

function extractApiKey(req: http.IncomingMessage): string | null {
  const auth = req.headers["authorization"];
  if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }
  const xkey = req.headers["x-api-key"];
  if (typeof xkey === "string" && xkey) return xkey.trim();
  const u = new URL(req.url ?? "/", "http://x");
  const q = u.searchParams.get("api_key");
  if (q) return q;
  return null;
}

function sendJson(res: http.ServerResponse, status: number, body: any) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function sendText(res: http.ServerResponse, status: number, body: string, ct = "text/plain; charset=utf-8") {
  res.writeHead(status, { "Content-Type": ct });
  res.end(body);
}

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>RobloxMCP — Dashboard</title>
<style>
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; font: 14px/1.45 ui-monospace, "JetBrains Mono", Consolas, monospace; background: #0b0d10; color: #d6deeb; }
header { padding: 16px 24px; border-bottom: 1px solid #1f2630; display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
header h1 { margin: 0; font-size: 18px; letter-spacing: 0.5px; color: #ff5277; }
header .sub { color: #6b7a90; font-size: 12px; }
header .auth-ui { margin-left: auto; display: flex; gap: 8px; align-items: center; }
header input { background: #11151b; color: #d6deeb; border: 1px solid #1f2630; padding: 6px 10px; border-radius: 6px; font: inherit; min-width: 200px; }
header button { background: #ff5277; color: #fff; border: 0; padding: 6px 14px; border-radius: 6px; font: inherit; cursor: pointer; font-weight: 600; }
header button.ghost { background: transparent; color: #6b7a90; border: 1px solid #1f2630; }
main { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; padding: 16px 24px; }
@media (max-width: 900px) { main { grid-template-columns: 1fr; } }
.card { background: #11151b; border: 1px solid #1f2630; border-radius: 8px; padding: 14px; }
.card h2 { margin: 0 0 10px; font-size: 12px; text-transform: uppercase; letter-spacing: 1px; color: #6b7a90; }
.stat { display: flex; justify-content: space-between; padding: 4px 0; border-bottom: 1px solid #1a2129; }
.stat:last-child { border: 0; } .stat .k { color: #6b7a90; } .stat .v { color: #d6deeb; }
.pill { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; }
.pill.ok { background: #1a3a25; color: #62e887; } .pill.bad { background: #3a1a1a; color: #ff5277; }
ul.list { list-style: none; padding: 0; margin: 0; max-height: 50vh; overflow-y: auto; }
ul.list li { padding: 8px 0; border-bottom: 1px solid #1a2129; }
ul.list li:last-child { border: 0; }
.row { display: grid; grid-template-columns: 90px 1fr 60px; gap: 10px; align-items: center; }
.row .t { color: #6b7a90; font-size: 11px; }
.row .name { color: #d6deeb; }
.row .badge { font-size: 10px; padding: 1px 6px; border-radius: 4px; text-align: center; }
.row .badge.ok { background: #1a3a25; color: #62e887; } .row .badge.bad { background: #3a1a1a; color: #ff5277; }
.err { color: #ff5277; font-size: 11px; margin-top: 2px; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #1a2129; font-size: 12px; }
th { color: #6b7a90; font-weight: 600; text-transform: uppercase; font-size: 10px; letter-spacing: 1px; }
td.id { color: #6b7a90; font-family: ui-monospace, monospace; font-size: 11px; }
.client-status { display: inline-flex; align-items: center; gap: 6px; }
.client-status .dot { width: 8px; height: 8px; border-radius: 50%; background: #62e887; }
.modal { position: fixed; inset: 0; background: rgba(0,0,0,0.7); display: none; align-items: center; justify-content: center; z-index: 999; padding: 20px; }
.modal.show { display: flex; }
.modal-box { background: #11151b; border: 1px solid #1f2630; border-radius: 12px; padding: 24px; max-width: 460px; width: 100%; }
.modal-box h2 { margin: 0 0 14px; font-size: 16px; color: #d6deeb; text-transform: none; letter-spacing: 0; }
.modal-box label { display: block; font-size: 11px; color: #6b7a90; margin: 12px 0 4px; text-transform: uppercase; letter-spacing: 1px; }
.modal-box input { width: 100%; background: #0b0d10; color: #d6deeb; border: 1px solid #1f2630; padding: 10px 12px; border-radius: 6px; font: inherit; }
.modal-box .actions { margin-top: 18px; display: flex; gap: 10px; }
.modal-box button { flex: 1; padding: 10px; border-radius: 6px; border: 0; font: inherit; font-weight: 600; cursor: pointer; }
.modal-box .primary { background: #ff5277; color: #fff; }
.modal-box .secondary { background: #1f2630; color: #d6deeb; }
.modal-box .tabs { display: flex; gap: 0; border-bottom: 1px solid #1f2630; margin-bottom: 12px; }
.modal-box .tab { padding: 8px 14px; cursor: pointer; color: #6b7a90; border-bottom: 2px solid transparent; }
.modal-box .tab.active { color: #ff5277; border-color: #ff5277; }
.modal-box .msg { padding: 8px 10px; border-radius: 6px; font-size: 12px; margin-top: 10px; }
.modal-box .msg.error { background: #3a1a1a; color: #ff5277; }
.modal-box .msg.ok { background: #1a3a25; color: #62e887; }
.codebox { background: #0b0d10; border: 1px solid #1f2630; border-radius: 6px; padding: 10px; word-break: break-all; font-size: 11px; color: #62e887; margin-top: 8px; }
footer { padding: 16px 24px; color: #4b5565; font-size: 11px; border-top: 1px solid #1f2630; }
</style>
</head>
<body>
<header>
  <h1>RobloxMCP</h1>
  <span class="sub" id="mode-sub">checking…</span>
  <span id="conn" class="pill bad">checking…</span>
  <div class="auth-ui" id="auth-ui"></div>
</header>
<main id="main"></main>
<footer>auto-refresh 1s · MCP endpoint <code>/mcp</code> · health <code>/health</code></footer>

<div class="modal" id="auth-modal">
  <div class="modal-box">
    <div class="tabs">
      <div class="tab active" data-tab="login">Login</div>
      <div class="tab" data-tab="register">Register</div>
    </div>
    <div id="tab-login">
      <label>Email</label>
      <input id="login-email" type="email" autocomplete="email">
      <label>Password</label>
      <input id="login-password" type="password" autocomplete="current-password">
      <div class="actions">
        <button class="primary" onclick="doLogin()">Login</button>
        <button class="secondary" onclick="closeModal()">Cancel</button>
      </div>
      <div id="login-msg"></div>
    </div>
    <div id="tab-register" style="display:none">
      <label>Email</label>
      <input id="reg-email" type="email" autocomplete="email">
      <label>Password (min 8 chars)</label>
      <input id="reg-password" type="password" autocomplete="new-password">
      <div class="actions">
        <button class="primary" onclick="doRegister()">Create account</button>
        <button class="secondary" onclick="closeModal()">Cancel</button>
      </div>
      <div id="reg-msg"></div>
    </div>
  </div>
</div>

<script>
const KEY_STORAGE = "robloxmcp_api_key";
let apiKey = localStorage.getItem(KEY_STORAGE) || (new URLSearchParams(location.search).get("api_key") || "");
if (apiKey && !localStorage.getItem(KEY_STORAGE)) localStorage.setItem(KEY_STORAGE, apiKey);
let authRequired = false;
let lastStatus = null;

function setAuthUi() {
  const el = document.getElementById('auth-ui');
  if (!authRequired) { el.innerHTML = '<span class="sub">local mode</span>'; return; }
  if (apiKey) {
    el.innerHTML = '<span class="sub">key …' + apiKey.slice(-6) + '</span>' +
      '<button class="ghost" onclick="copyKey()">copy key</button>' +
      '<button class="ghost" onclick="logout()">logout</button>';
  } else {
    el.innerHTML = '<button onclick="openModal()">Login / Register</button>';
  }
}

function openModal() { document.getElementById('auth-modal').classList.add('show'); }
function closeModal() { document.getElementById('auth-modal').classList.remove('show'); }
document.querySelectorAll('.tab').forEach(t => t.onclick = () => {
  document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
  t.classList.add('active');
  document.getElementById('tab-login').style.display = t.dataset.tab === 'login' ? 'block' : 'none';
  document.getElementById('tab-register').style.display = t.dataset.tab === 'register' ? 'block' : 'none';
});

async function doRegister() {
  const email = document.getElementById('reg-email').value.trim();
  const password = document.getElementById('reg-password').value;
  const msg = document.getElementById('reg-msg');
  msg.className = '';
  try {
    const r = await fetch('/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
    const j = await r.json();
    if (!r.ok) { msg.className = 'msg error'; msg.textContent = j.error || 'register failed'; return; }
    apiKey = j.api_key;
    localStorage.setItem(KEY_STORAGE, apiKey);
    msg.className = 'msg ok';
    msg.innerHTML = 'account created. your API key:<div class="codebox">' + apiKey + '</div>save it.';
    setTimeout(() => { closeModal(); setAuthUi(); refresh(); }, 3000);
  } catch (e) { msg.className = 'msg error'; msg.textContent = String(e); }
}

async function doLogin() {
  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  const msg = document.getElementById('login-msg');
  msg.className = '';
  try {
    const r = await fetch('/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
    const j = await r.json();
    if (!r.ok) { msg.className = 'msg error'; msg.textContent = j.error || 'login failed'; return; }
    if (!j.api_keys || j.api_keys.length === 0) {
      msg.className = 'msg error'; msg.textContent = 'no active API keys for this account';
      return;
    }
    apiKey = j.api_keys[0].api_key;
    localStorage.setItem(KEY_STORAGE, apiKey);
    closeModal();
    setAuthUi(); refresh();
  } catch (e) { msg.className = 'msg error'; msg.textContent = String(e); }
}

function logout() { localStorage.removeItem(KEY_STORAGE); apiKey = ""; setAuthUi(); refresh(); }
function copyKey() { navigator.clipboard.writeText(apiKey); }

function authHeader() { return apiKey ? { 'Authorization': 'Bearer ' + apiKey } : {}; }

async function refresh() {
  try {
    const s = await fetch('/api/status', { headers: authHeader() }).then(r => r.json());
    authRequired = s.auth_required;
    document.getElementById('mode-sub').textContent = authRequired ? 'production mode · v0.3.0' : 'local mode · v0.3.0';
    setAuthUi();

    const conn = document.getElementById('conn');
    if (authRequired && !apiKey) {
      conn.className = 'pill bad'; conn.textContent = 'login required';
      document.getElementById('main').innerHTML = '<section class="card"><h2>Login required</h2><p style="color:#6b7a90">This server runs in production mode. Click "Login / Register" above to continue.</p></section>';
      return;
    }

    const [clients, calls, history, sessions] = await Promise.all([
      fetch('/api/my-clients', { headers: authHeader() }).then(r => r.ok ? r.json() : []),
      fetch('/api/tool-log?limit=80', { headers: authHeader() }).then(r => r.json()),
      authRequired ? fetch('/api/login-history', { headers: authHeader() }).then(r => r.ok ? r.json() : []) : Promise.resolve([]),
      authRequired ? fetch('/api/sessions', { headers: authHeader() }).then(r => r.ok ? r.json() : []) : Promise.resolve([]),
    ]);

    if (clients.length > 0) { conn.className = 'pill ok'; conn.textContent = clients.length + ' client' + (clients.length === 1 ? '' : 's') + ' online'; }
    else { conn.className = 'pill bad'; conn.textContent = 'no clients'; }

    let html = '';
    html += '<section class="card"><h2>Status</h2>' +
      mkStat('Mode', authRequired ? 'production' : 'local') +
      mkStat('My Roblox clients', clients.length) +
      mkStat('HTTP port', s.http_port) +
      mkStat('WS port', s.ws_port) +
      mkStat('Tools registered', s.tool_count) +
      mkStat('Tool calls (you)', s.your_tool_calls) +
      mkStat('Snapshots (you)', s.your_snapshots) +
      mkStat('DB', s.db_ok ? '<span class="pill ok">ok</span>' : '<span class="pill bad">down</span>') +
      mkStat('Uptime', s.uptime_s + ' s') +
      '</section>';

    html += '<section class="card"><h2>Connected clients</h2>';
    if (clients.length === 0) html += '<p style="color:#6b7a90">No Roblox clients connected. Paste roblox/client.lua in your executor.</p>';
    else {
      html += '<table><thead><tr><th>Roblox</th><th>Device</th><th>Executor</th><th>Status</th><th>client_id</th></tr></thead><tbody>';
      for (const c of clients) {
        html += '<tr>' +
          '<td>' + (c.roblox_user_name || c.roblox_user_id || '—') + '</td>' +
          '<td>' + esc(c.device_type) + '</td>' +
          '<td>' + esc(c.executor) + '</td>' +
          '<td><span class="client-status"><span class="dot"></span>' + esc(c.status) + '</span></td>' +
          '<td class="id">' + c.client_id + '</td>' +
          '</tr>';
      }
      html += '</tbody></table>';
    }
    html += '</section>';

    html += '<section class="card"><h2>Recent tool calls</h2><ul class="list">';
    if (!calls.length) html += '<li><span style="color:#6b7a90">no calls yet</span></li>';
    else for (const c of calls.slice().reverse()) {
      const errLine = c.error ? '<div class="err">' + esc(c.error) + '</div>' : '';
      html += '<li class="row">' +
        '<span class="t">' + tm(c.ts) + '</span>' +
        '<span><span class="name">' + esc(c.tool) + '</span>' + errLine + '</span>' +
        '<span class="badge ' + (c.ok ? 'ok' : 'bad') + '">' + (c.ok ? 'OK' : 'ERR') + '</span>' +
        '</li>';
    }
    html += '</ul></section>';

    if (authRequired) {
      html += '<section class="card"><h2>Login history (masked IP)</h2><ul class="list">';
      if (!history.length) html += '<li><span style="color:#6b7a90">no history</span></li>';
      else for (const h of history) {
        html += '<li class="row">' +
          '<span class="t">' + tm(new Date(h.at).getTime()) + '</span>' +
          '<span><span class="name">' + esc(h.ip_masked) + '</span><div class="err" style="color:#6b7a90">' + esc(h.user_agent || '') + '</div></span>' +
          '<span class="badge ' + (h.success ? 'ok' : 'bad') + '">' + (h.success ? 'OK' : 'FAIL') + '</span>' +
          '</li>';
      }
      html += '</ul></section>';

      html += '<section class="card"><h2>Recent sessions</h2><ul class="list">';
      if (!sessions.length) html += '<li><span style="color:#6b7a90">no sessions</span></li>';
      else for (const ss of sessions.slice(0, 20)) {
        const live = !ss.disconnected_at;
        html += '<li class="row">' +
          '<span class="t">' + tm(new Date(ss.connected_at).getTime()) + '</span>' +
          '<span><span class="name">' + esc(ss.roblox_user_name || ss.roblox_user_id || '—') + ' · ' + esc(ss.device_type) + ' · ' + esc(ss.executor) + '</span><div class="err" style="color:#6b7a90">' + esc(ss.ip_masked || '') + '</div></span>' +
          '<span class="badge ' + (live ? 'ok' : 'bad') + '">' + (live ? 'LIVE' : 'CLOSED') + '</span>' +
          '</li>';
      }
      html += '</ul></section>';
    }

    document.getElementById('main').innerHTML = html;
  } catch (e) {
    document.getElementById('conn').textContent = 'dashboard error';
  }
}

function mkStat(k, v) { return '<div class="stat"><span class="k">' + k + '</span><span class="v">' + v + '</span></div>'; }
function tm(ts) { return new Date(ts).toTimeString().slice(0, 8); }
function esc(s) { return String(s).replace(/[<>&]/g, x => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[x])); }

refresh(); setInterval(refresh, 1000);
</script>
</body>
</html>`;

async function authMiddleware(req: http.IncomingMessage): Promise<{ userId: number | null; ok: boolean }> {
  if (!AUTH_REQUIRED) return { userId: null, ok: true };
  const key = extractApiKey(req);
  if (!key) return { userId: null, ok: false };
  const resolved = await resolveApiKey(key);
  if (!resolved) return { userId: null, ok: false };
  return { userId: resolved.user_id, ok: true };
}

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
  const u = new URL(req.url ?? "/", "http://x");
  const pathname = u.pathname;
  const ipMasked = maskIp(clientIpFromReq(req));
  const ua = (req.headers["user-agent"] as string) || null;

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Api-Key",
    });
    res.end();
    return;
  }

  res.setHeader("Access-Control-Allow-Origin", "*");

  if (req.method === "GET" && (pathname === "/" || pathname === "/dashboard")) {
    sendText(res, 200, DASHBOARD_HTML, "text/html; charset=utf-8");
    return;
  }

  if (req.method === "GET" && pathname === "/health") {
    sendJson(res, 200, {
      ok: true,
      auth_required: AUTH_REQUIRED,
      db_ok: AUTH_REQUIRED ? await dbHealth() : null,
      total_clients: bridge.registry.totalCount(),
    });
    return;
  }

  if (pathname === "/auth/register") {
    if (req.method !== "POST") return sendJson(res, 405, { error: "POST only" });
    if (!AUTH_REQUIRED) return sendJson(res, 400, { error: "auth not enabled (set DB_HOST)" });
    const body = await readJsonBody(req).catch(() => null);
    if (!body) return sendJson(res, 400, { error: "invalid JSON body" });
    try {
      const r = await registerUser(String(body.email ?? ""), String(body.password ?? ""));
      return sendJson(res, 200, r);
    } catch (e: any) {
      return sendJson(res, 400, { error: String(e?.message ?? e) });
    }
  }

  if (pathname === "/auth/login") {
    if (req.method !== "POST") return sendJson(res, 405, { error: "POST only" });
    if (!AUTH_REQUIRED) return sendJson(res, 400, { error: "auth not enabled (set DB_HOST)" });
    const body = await readJsonBody(req).catch(() => null);
    if (!body) return sendJson(res, 400, { error: "invalid JSON body" });
    const r = await loginUser(String(body.email ?? ""), String(body.password ?? ""), ipMasked, ua);
    if (!r) return sendJson(res, 401, { error: "invalid credentials" });
    return sendJson(res, 200, r);
  }

  const auth = await authMiddleware(req);

  if (pathname === "/auth/keys") {
    if (!AUTH_REQUIRED) return sendJson(res, 400, { error: "auth not enabled" });
    if (!auth.ok || auth.userId == null) return sendJson(res, 401, { error: "unauthorized" });
    if (req.method === "GET") return sendJson(res, 200, await listApiKeys(auth.userId));
    if (req.method === "POST") {
      const body = await readJsonBody(req).catch(() => ({}));
      const key = await createApiKey(auth.userId, String(body?.label ?? "").trim() || null);
      return sendJson(res, 200, { api_key: key });
    }
    return sendJson(res, 405, { error: "method not allowed" });
  }

  if (pathname.startsWith("/auth/keys/") && req.method === "DELETE") {
    if (!auth.ok || auth.userId == null) return sendJson(res, 401, { error: "unauthorized" });
    const id = Number(pathname.split("/").pop());
    if (!Number.isFinite(id)) return sendJson(res, 400, { error: "invalid id" });
    const ok = await revokeApiKey(auth.userId, id);
    return sendJson(res, 200, { revoked: ok });
  }

  if (pathname === "/api/login-history" && req.method === "GET") {
    if (!auth.ok || auth.userId == null) return sendJson(res, 401, { error: "unauthorized" });
    return sendJson(res, 200, await getLoginHistory(auth.userId, 50));
  }

  if (pathname === "/api/sessions" && req.method === "GET") {
    if (!auth.ok || auth.userId == null) return sendJson(res, 401, { error: "unauthorized" });
    return sendJson(res, 200, await recentSessions(auth.userId, 50));
  }

  if (pathname === "/api/my-clients" && req.method === "GET") {
    if (AUTH_REQUIRED && (!auth.ok || auth.userId == null)) return sendJson(res, 401, { error: "unauthorized" });
    return sendJson(res, 200, bridge.registry.listByUser(auth.userId).map((c) => ({
      client_id: c.client_id,
      roblox_user_id: c.roblox_user_id,
      roblox_user_name: c.roblox_user_name,
      device_type: c.device_type,
      executor: c.executor,
      status: c.status,
      capabilities: c.capabilities,
      ip_masked: c.ip_masked,
      connected_for_s: Math.floor((Date.now() - c.connected_at) / 1000),
    })));
  }

  if (pathname === "/api/status" && req.method === "GET") {
    return sendJson(res, 200, {
      ok: true,
      auth_required: AUTH_REQUIRED,
      authed: auth.ok,
      db_ok: AUTH_REQUIRED ? await dbHealth() : null,
      http_port: HTTP_PORT,
      ws_port: WS_PORT,
      tool_count: tools.length,
      total_clients: bridge.registry.totalCount(),
      your_clients: bridge.registry.listByUser(auth.userId).length,
      your_tool_calls: bridge.getToolCalls(auth.userId, 9999).length,
      your_snapshots: bridge.snapshotCount(auth.userId),
      uptime_s: Math.floor((Date.now() - startTime) / 1000),
    });
  }

  if (pathname === "/api/tool-log" && req.method === "GET") {
    if (AUTH_REQUIRED && (!auth.ok || auth.userId == null)) return sendJson(res, 401, { error: "unauthorized" });
    const limit = Number(u.searchParams.get("limit") ?? 100);
    return sendJson(res, 200, bridge.getToolCalls(auth.userId, limit));
  }

  if (req.method === "POST" && pathname === "/mcp") {
    if (AUTH_REQUIRED && (!auth.ok || auth.userId == null)) {
      return sendJson(res, 401, { error: "missing or invalid API key (send Authorization: Bearer <key>)" });
    }
    const body = await readJsonBody(req);
    const server = buildServer(auth.userId);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
    return;
  }

  sendText(res, 404, "not found — see /, /mcp, /health, /auth/*, /api/*");
}

async function startHttp() {
  const httpServer = http.createServer(async (req, res) => {
    try { await handleRequest(req, res); }
    catch (e: any) {
      process.stderr.write(`[http] error: ${e?.message ?? e}\n`);
      if (!res.headersSent) sendJson(res, 500, { error: String(e?.message ?? e) });
    }
  });

  httpServer.listen(HTTP_PORT, HTTP_HOST, () => {
    process.stderr.write(`[RobloxMCP] HTTP MCP at http://${HTTP_HOST}:${HTTP_PORT}/mcp (WS bridge ${WS_HOST}:${WS_PORT})\n`);
    process.stderr.write(`[RobloxMCP] dashboard at http://${HTTP_HOST}:${HTTP_PORT}/\n`);
    process.stderr.write(`[RobloxMCP] mode: ${AUTH_REQUIRED ? "production (auth required)" : "local (no auth)"}\n`);
  });

  const shutdown = () => {
    process.stderr.write(`[RobloxMCP] shutting down\n`);
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function startStdio() {
  const server = buildServer(null);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`[RobloxMCP] stdio MCP ready. WS bridge ${WS_HOST}:${WS_PORT}\n`);
}

async function main() {
  if (useHttp) await startHttp();
  else await startStdio();
}

main().catch((e) => { process.stderr.write(`fatal: ${e}\n`); process.exit(1); });
