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
      version: "0.1.0",
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
    if (!tool) {
      return {
        isError: true,
        content: [{ type: "text", text: `Unknown tool: ${req.params.name}` }],
      };
    }
    try {
      const args = tool.inputSchema.parse(req.params.arguments ?? {});
      const result = await tool.handler(args);

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
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, roblox_connected: bridge.isConnected() }));
        return;
      }
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found — POST /mcp or GET /health");
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
