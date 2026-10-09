// HTTP entrypoint: stateless Streamable HTTP MCP at POST /mcp via the
// official v2 createMcpHandler (JSON response mode), GET /healthz for
// deployment checks (process health only, no providers).
//
// The handler factory creates a fresh McpServer for every request — server
// and transport instances are never shared across callers.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { createMcpServer } from "./mcp/server.js";

const PORT = Number(process.env.PORT ?? 3000);
const RPM = Number(process.env.RATE_LIMIT_RPM ?? 60);
const MAX_BODY_BYTES = 1_000_000;

const mcpHandler = createMcpHandler(() => createMcpServer(), {
  responseMode: "json",
});

const windows = new Map<string, { count: number; reset: number }>();
function rateLimited(ip: string): boolean {
  if (RPM <= 0) return false;
  const now = Date.now();
  const w = windows.get(ip);
  if (!w || now >= w.reset) {
    windows.set(ip, { count: 1, reset: now + 60_000 });
    return false;
  }
  w.count += 1;
  return w.count > RPM;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, w] of windows) if (now >= w.reset) windows.delete(ip);
}, 60_000).unref();

function clientIp(req: IncomingMessage): string {
  const fwd = req.headers["x-forwarded-for"];
  return (
    (typeof fwd === "string" ? fwd.split(",")[0].trim() : "") ||
    req.socket.remoteAddress ||
    "unknown"
  );
}

function readBodyBuffer(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const host = req.headers.host ?? "localhost";
    const url = new URL(req.url ?? "/mcp", `http://${host}`);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined) continue;
      headers.set(k, Array.isArray(v) ? v.join(", ") : v);
    }
    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    const buf = hasBody ? await readBodyBuffer(req) : null;
    const bodyInit = ((): ArrayBuffer | undefined => {
      if (!buf || buf.length === 0) return undefined;
      const ab = new ArrayBuffer(buf.length);
      new Uint8Array(ab).set(buf);
      return ab;
    })();
    const request = new Request(url, {
      method: req.method,
      headers,
      body: bodyInit,
    });
    const response = await mcpHandler.fetch(request);
    const outHeaders: Record<string, string> = {};
    response.headers.forEach((v, k) => {
      outHeaders[k] = v;
    });
    res.writeHead(response.status, outHeaders);
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (err) {
    if (!res.headersSent) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String((err as Error)?.message ?? err).slice(0, 200) }));
    }
  }
}

const LANDING_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Trinity Sermons — find the Trinity New York message for your situation (MCP)</title>
<meta name="description" content="A free public MCP server that finds complete Trinity New York sermons matching a topic or life situation, with YouTube links.">
</head>
<body style="font-family: system-ui, sans-serif; max-width: 640px; margin: 3rem auto; padding: 0 1.5rem; line-height: 1.6;">
<h1>Trinity Sermons</h1>
<p>A free public MCP server: ask which complete Trinity New York sermon fits a topic or life situation, and get whole-message matches with YouTube links.</p>
<p>MCP endpoint (Streamable HTTP): <code>POST /mcp</code><br>Health: <code>GET /healthz</code></p>
<p>Tools: <code>search_sermons</code>, <code>get_sermon</code>, <code>list_recent_sermons</code>. Read-only, no sign-up.</p>
</body>
</html>`;

function cors(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Mcp-Session-Id");
}

const httpServer = createServer((req, res) => {
  cors(res);
  if (rateLimited(clientIp(req))) {
    res.writeHead(429, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "rate limit exceeded" }));
    return;
  }
  const url = new URL(req.url ?? "/", "http://localhost");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  if (url.pathname === "/healthz" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (url.pathname === "/" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(LANDING_HTML);
    return;
  }
  if (url.pathname === "/mcp" && (req.method === "POST" || req.method === "GET")) {
    void handleMcp(req, res);
    return;
  }
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

httpServer.listen(PORT, () => {
  console.log(`trinity-sermons MCP (stateless Streamable HTTP) listening on :${PORT}/mcp`);
});
