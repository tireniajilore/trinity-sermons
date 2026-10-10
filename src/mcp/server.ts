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
import { listSeriesTool } from "../tools/list-series.js";
import { listSeriesSermonsTool } from "../tools/list-series-sermons.js";
import { findSimilarTool } from "../tools/find-similar-sermons.js";

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

  server.registerTool(
    listSeriesTool.name,
    {
      description: listSeriesTool.description,
      inputSchema: listSeriesTool.inputSchema,
      outputSchema: listSeriesTool.outputSchema,
      annotations: listSeriesTool.annotations,
    },
    async (args) => listSeriesTool.handler(deps, args)
  );

  server.registerTool(
    listSeriesSermonsTool.name,
    {
      description: listSeriesSermonsTool.description,
      inputSchema: listSeriesSermonsTool.inputSchema,
      outputSchema: listSeriesSermonsTool.outputSchema,
      annotations: listSeriesSermonsTool.annotations,
    },
    async (args) => listSeriesSermonsTool.handler(deps, args)
  );

  server.registerTool(
    findSimilarTool.name,
    {
      description: findSimilarTool.description,
      inputSchema: findSimilarTool.inputSchema,
      outputSchema: findSimilarTool.outputSchema,
      annotations: findSimilarTool.annotations,
    },
    async (args) => findSimilarTool.handler(deps, args)
  );

  return server;
}
