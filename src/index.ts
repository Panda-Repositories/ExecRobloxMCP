#!/usr/bin/env node
import http from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import { RobloxBridge } from "./bridge.js";
import { buildTools } from "./tools.js";

const WS_PORT = Number(process.env.ROBLOX_WS_PORT ?? 8765);

const HTTP_PORT_ENV = process.env.MCP_HTTP_PORT;
const useHttp = process.argv.includes("--http") || HTTP_PORT_ENV !== undefined;
const HTTP_PORT = Number(HTTP_PORT_ENV ?? 8766);

const bridge = new RobloxBridge(WS_PORT);
const tools = buildTools(bridge);
const toolMap = new Map(tools.map((t) => [t.name, t]));

function buildServer(): Server {
  const server = new Server(
    {
      name: "RobloxMCP",
      version: "0.2.0",
    },
    {
      capabilities: { tools: {} },
    },
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
      bridge.logToolCall(req.params.name, false, 0, "unknown tool");
      return {
        isError: true,
        content: [{ type: "text", text: `Unknown tool: ${req.params.name}` }],
      };
    }
    try {
      const args = tool.inputSchema.parse(req.params.arguments ?? {});
      const result = await tool.handler(args);
      bridge.logToolCall(tool.name, true, Date.now() - t0);

      if (result && typeof result === "object" && typeof (result as any).image_base64 === "string") {
        const r = result as any;
        const content: any[] = [
          { type: "image", data: r.image_base64, mimeType: r.mime_type ?? "image/png" },
        ];
        const meta: Record<string, any> = { ...r };
        delete meta.image_base64;
        delete meta.mime_type;
        if (Object.keys(meta).length > 0) {
          content.push({ type: "text", text: JSON.stringify(meta, null, 2) });
        }
        return { content };
      }

      return {
        content: [
          {
            type: "text",
            text: typeof result === "string" ? result : JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err: any) {
      bridge.logToolCall(tool.name, false, Date.now() - t0, String(err?.message ?? err));
      return {
        isError: true,
        content: [{ type: "text", text: `Error: ${err.message ?? String(err)}` }],
      };
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

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>RobloxMCP — Dashboard</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.45 ui-monospace, "JetBrains Mono", Consolas, monospace; background: #0b0d10; color: #d6deeb; }
  header { padding: 18px 24px; border-bottom: 1px solid #1f2630; display: flex; align-items: baseline; gap: 16px; }
  header h1 { margin: 0; font-size: 18px; letter-spacing: 0.5px; color: #ff5277; }
  header .sub { color: #6b7a90; font-size: 12px; }
  main { display: grid; grid-template-columns: 1fr 2fr; gap: 16px; padding: 16px 24px; }
  .card { background: #11151b; border: 1px solid #1f2630; border-radius: 8px; padding: 14px; }
  .card h2 { margin: 0 0 10px; font-size: 12px; text-transform: uppercase; letter-spacing: 1px; color: #6b7a90; }
  .stat { display: flex; justify-content: space-between; padding: 4px 0; border-bottom: 1px solid #1a2129; }
  .stat:last-child { border: 0; }
  .stat .k { color: #6b7a90; }
  .stat .v { color: #d6deeb; }
  .pill { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; }
  .pill.ok { background: #1a3a25; color: #62e887; }
  .pill.bad { background: #3a1a1a; color: #ff5277; }
  ul.calls { list-style: none; padding: 0; margin: 0; max-height: 60vh; overflow-y: auto; }
  ul.calls li { padding: 6px 0; border-bottom: 1px solid #1a2129; display: grid; grid-template-columns: 80px 1fr 60px 60px; gap: 10px; align-items: center; }
  ul.calls li:last-child { border: 0; }
  ul.calls .t { color: #6b7a90; font-size: 11px; }
  ul.calls .name { color: #d6deeb; }
  ul.calls .ms { color: #6b7a90; font-size: 11px; text-align: right; }
  ul.calls .badge { font-size: 10px; padding: 1px 6px; border-radius: 4px; text-align: center; }
  ul.calls .badge.ok { background: #1a3a25; color: #62e887; }
  ul.calls .badge.bad { background: #3a1a1a; color: #ff5277; }
  .err { color: #ff5277; font-size: 11px; margin-top: 2px; }
  footer { padding: 16px 24px; color: #4b5565; font-size: 11px; border-top: 1px solid #1f2630; }
</style>
</head>
<body>
<header>
  <h1>RobloxMCP</h1>
  <span class="sub">v0.2.0 — live dashboard</span>
  <span id="conn" class="pill bad" style="margin-left:auto">checking…</span>
</header>
<main>
  <section class="card">
    <h2>Status</h2>
    <div id="status"></div>
  </section>
  <section class="card">
    <h2>Recent tool calls</h2>
    <ul class="calls" id="calls"></ul>
  </section>
</main>
<footer>auto-refresh every 1 s &nbsp;·&nbsp; MCP endpoint: <code>/mcp</code> &nbsp;·&nbsp; health: <code>/health</code></footer>
<script>
function fmtTime(ts) {
  const d = new Date(ts);
  return d.toTimeString().slice(0, 8);
}
async function refresh() {
  try {
    const [s, calls] = await Promise.all([
      fetch('/api/status').then(r => r.json()),
      fetch('/api/tool-log?limit=80').then(r => r.json()),
    ]);
    const connEl = document.getElementById('conn');
    if (s.roblox_connected) {
      connEl.className = 'pill ok';
      connEl.textContent = 'roblox connected';
    } else {
      connEl.className = 'pill bad';
      connEl.textContent = 'no roblox client';
    }
    document.getElementById('status').innerHTML = [
      ['Roblox client', s.roblox_connected ? '<span class="pill ok">connected</span>' : '<span class="pill bad">disconnected</span>'],
      ['HTTP port', s.http_port],
      ['WS port', s.ws_port],
      ['Tools registered', s.tool_count],
      ['Snapshots stored', s.snapshots],
      ['Tool calls (session)', s.total_tool_calls],
      ['Uptime', s.uptime_s + ' s'],
    ].map(([k, v]) => '<div class="stat"><span class="k">' + k + '</span><span class="v">' + v + '</span></div>').join('');
    const list = calls.slice().reverse().map(c => {
      const errLine = c.error ? '<div class="err">' + c.error.replace(/[<>&]/g, x => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[x])) + '</div>' : '';
      return '<li>' +
        '<span class="t">' + fmtTime(c.ts) + '</span>' +
        '<span><span class="name">' + c.tool + '</span>' + errLine + '</span>' +
        '<span class="badge ' + (c.ok ? 'ok' : 'bad') + '">' + (c.ok ? 'OK' : 'ERR') + '</span>' +
        '<span class="ms">' + c.ms + ' ms</span>' +
      '</li>';
    }).join('');
    document.getElementById('calls').innerHTML = list || '<li><span class="t" style="grid-column:1/-1">no calls yet</span></li>';
  } catch (e) {
    document.getElementById('conn').textContent = 'dashboard error';
  }
}
refresh();
setInterval(refresh, 1000);
</script>
</body>
</html>`;

const startTime = Date.now();

async function startHttp() {
  const httpServer = http.createServer(async (req, res) => {
    try {
      if (req.method === "POST" && req.url === "/mcp") {
        const body = await readJsonBody(req);
        const server = buildServer();
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on("close", () => {
          transport.close().catch(() => {});
          server.close().catch(() => {});
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
        return;
      }
      if (req.method === "GET" && (req.url === "/" || req.url === "/dashboard")) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(DASHBOARD_HTML);
        return;
      }
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, roblox_connected: bridge.isConnected() }));
        return;
      }
      if (req.method === "GET" && req.url === "/api/status") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          ok: true,
          roblox_connected: bridge.isConnected(),
          http_port: HTTP_PORT,
          ws_port: WS_PORT,
          tool_count: tools.length,
          snapshots: bridge.snapshotCount(),
          total_tool_calls: bridge.getToolCalls(99999).length,
          uptime_s: Math.floor((Date.now() - startTime) / 1000),
        }));
        return;
      }
      if (req.method === "GET" && req.url?.startsWith("/api/tool-log")) {
        const u = new URL(req.url, "http://x");
        const limit = Number(u.searchParams.get("limit") ?? 100);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(bridge.getToolCalls(limit)));
        return;
      }
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found — try /, /mcp, /health, /api/status, /api/tool-log");
    } catch (e: any) {
      process.stderr.write(`[http] error: ${e?.message ?? e}\n`);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(e?.message ?? e) }));
      }
    }
  });

  httpServer.listen(HTTP_PORT, "127.0.0.1", () => {
    process.stderr.write(
      `[RobloxMCP] HTTP MCP at http://127.0.0.1:${HTTP_PORT}/mcp (WS bridge port: ${WS_PORT})\n`,
    );
    process.stderr.write(
      `[RobloxMCP] dashboard at http://127.0.0.1:${HTTP_PORT}/\n`,
    );
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
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`[RobloxMCP] stdio MCP ready. WS bridge port: ${WS_PORT}\n`);
}

async function main() {
  if (useHttp) await startHttp();
  else await startStdio();
}

main().catch((e) => {
  process.stderr.write(`fatal: ${e}\n`);
  process.exit(1);
});
