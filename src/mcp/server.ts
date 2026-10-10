// MCP server factory. A fresh McpServer is created for every HTTP request
// (see src/index.ts) — server and transport instances are never shared
// across callers.

import { McpServer } from "@modelcontextprotocol/server";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
import { verifyQuoteTool } from "../tools/verify-quote.js";
import { verifyRefsTool } from "../tools/verify-sermon-refs.js";
import { citeSermonsTool } from "../tools/cite-sermons.js";

export const SERVER_NAME = "trinity-sermons";
export const SERVER_VERSION = "1.0.0";

const SKILL_URI = "skill://trinity-sermons/faith-assistant";

function loadSkill(): string {
  const dir = dirname(fileURLToPath(import.meta.url));
  // src/mcp/server.ts -> <root>/skills/faith-assistant/SKILL.md
  const path = join(dir, "..", "..", "skills", "faith-assistant", "SKILL.md");
  return readFileSync(path, "utf8");
}

export function createMcpServer(deps: PipelineDeps = defaultPipelineDeps()): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {}, resources: {} } }
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

  server.registerTool(
    verifyQuoteTool.name,
    {
      description: verifyQuoteTool.description,
      inputSchema: verifyQuoteTool.inputSchema,
      outputSchema: verifyQuoteTool.outputSchema,
      annotations: verifyQuoteTool.annotations,
    },
    async (args) => verifyQuoteTool.handler(deps, args)
  );

  server.registerTool(
    verifyRefsTool.name,
    {
      description: verifyRefsTool.description,
      inputSchema: verifyRefsTool.inputSchema,
      outputSchema: verifyRefsTool.outputSchema,
      annotations: verifyRefsTool.annotations,
    },
    async (args) => verifyRefsTool.handler(deps, args)
  );

  server.registerTool(
    citeSermonsTool.name,
    {
      description: citeSermonsTool.description,
      inputSchema: citeSermonsTool.inputSchema,
      outputSchema: citeSermonsTool.outputSchema,
      annotations: citeSermonsTool.annotations,
    },
    async (args) => citeSermonsTool.handler(deps, args)
  );

  // Faith-assistant skill as a resource: guidance on using these tools well
  // (no invented quotes, correct attribution, honest empties). Clients that
  // understand Agent Skills can load skill://trinity-sermons/faith-assistant.
  server.registerResource(
    "faith-assistant-skill",
    SKILL_URI,
    {
      title: "Trinity Faith Assistant",
      description:
        "How to be a good faith assistant with these tools: when to use each tool, and ground rules (never invent quotes, attribute correctly, say when nothing matches).",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "text/markdown",
          text: loadSkill(),
        },
      ],
    })
  );

  return server;
}
