#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import { RobloxBridge } from "./bridge.js";
import { buildTools } from "./tools.js";

const WS_PORT = Number(process.env.ROBLOX_WS_PORT ?? 8765);
const WS_TOKEN = process.env.ROBLOX_MCP_TOKEN;

const bridge = new RobloxBridge(WS_PORT, WS_TOKEN);
const tools = buildTools(bridge);
const toolMap = new Map(tools.map((t) => [t.name, t]));

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

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`[RobloxMCP] stdio MCP ready. WS bridge port: ${WS_PORT}\n`);
}

main().catch((e) => {
  process.stderr.write(`fatal: ${e}\n`);
  process.exit(1);
});
