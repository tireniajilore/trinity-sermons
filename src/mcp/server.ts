// MCP server factory. A fresh McpServer is created for every HTTP request
// (see src/index.ts) — server and transport instances are never shared
// across callers.

import { McpServer } from "@modelcontextprotocol/server";
import {
  defaultPipelineDeps,
  type PipelineDeps,
} from "../retrieval/pipeline.js";
import { searchSermonsTool } from "../tools/search-sermons.js";
import { getSermonTool } from "../tools/get-sermon.js";
import { listRecentTool } from "../tools/list-recent.js";

export const SERVER_NAME = "trinity-sermons";
export const SERVER_VERSION = "1.0.0";

export function createMcpServer(deps: PipelineDeps = defaultPipelineDeps()): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } }
  );

  server.registerTool(
    searchSermonsTool.name,
    {
      description: searchSermonsTool.description,
      inputSchema: searchSermonsTool.inputSchema,
      outputSchema: searchSermonsTool.outputSchema,
      annotations: searchSermonsTool.annotations,
    },
    async (args) => searchSermonsTool.handler(deps, args)
  );

  server.registerTool(
    getSermonTool.name,
    {
      description: getSermonTool.description,
      inputSchema: getSermonTool.inputSchema,
      outputSchema: getSermonTool.outputSchema,
      annotations: getSermonTool.annotations,
    },
    async (args) => getSermonTool.handler(deps, args)
  );

  server.registerTool(
    listRecentTool.name,
    {
      description: listRecentTool.description,
      inputSchema: listRecentTool.inputSchema,
      outputSchema: listRecentTool.outputSchema,
      annotations: listRecentTool.annotations,
    },
    async (args) => listRecentTool.handler(deps, args)
  );

  return server;
}
