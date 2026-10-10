// MCP contract tests: in-process HTTP server, raw JSON-RPC over the real
// /mcp route. Verifies tool surface, schemas, annotations, error codes,
// text/structured agreement, and per-request isolation.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const PORT = 31873;
const BASE = `http://127.0.0.1:${PORT}`;

let child = null;

function parseRpc(text) {
  const t = text.trim();
  if (t.startsWith("{")) return JSON.parse(t);
  const m = t.match(/^data: (.+)$/m);
  assert.ok(m, `expected JSON or SSE response, got: ${t.slice(0, 200)}`);
  return JSON.parse(m[1]);
}

async function rpc(method, params, id = 1) {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  assert.equal(res.status, 200, `HTTP ${res.status} for ${method}`);
  return parseRpc(await res.text());
}

async function callTool(name, args, id = 1) {
  const resp = await rpc("tools/call", { name, arguments: args }, id);
  assert.ok(!resp.error, `RPC error for ${name}: ${JSON.stringify(resp.error)}`);
  return resp.result;
}

const YT_RE = /^https:\/\/www\.youtube\.com\/watch\?v=[\w-]+$/;

before(async () => {
  child = spawn("node", ["dist/index.js"], {
    env: { ...process.env, PORT: String(PORT), RATE_LIMIT_RPM: "0" },
    stdio: "ignore",
  });
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      const r = await fetch(`${BASE}/healthz`);
      if (r.ok) break;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error("server did not start");
    await new Promise((r) => setTimeout(r, 200));
  }
});

after(() => {
  child?.kill();
});

test("healthz reports process health", async () => {
  const r = await fetch(`${BASE}/healthz`);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
});

test("initialize reports server identity", async () => {
  const resp = await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "contract-test", version: "0.0.0" },
  });
  assert.equal(resp.result.serverInfo.name, "trinity-sermons");
  assert.equal(resp.result.serverInfo.version, "1.0.0");
});

test("tools/list exposes exactly the seven documented tools", async () => {
  const resp = await rpc("tools/list", {});
  const names = resp.result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["find_similar_sermons", "get_sermon", "list_recent_sermons", "list_series", "list_series_sermons", "search_sermons", "verify_quote"]);
  for (const t of resp.result.tools) {
    assert.equal(t.annotations.readOnlyHint, true, `${t.name} readOnlyHint`);
    assert.equal(t.annotations.destructiveHint, false, `${t.name} destructiveHint`);
    assert.equal(t.annotations.idempotentHint, true, `${t.name} idempotentHint`);
    assert.equal(t.annotations.openWorldHint, false, `${t.name} openWorldHint`);
    assert.ok(t.inputSchema, `${t.name} inputSchema`);
    assert.ok(t.outputSchema, `${t.name} outputSchema`);
  }
});

test("search_sermons: marriage query returns the marriage sermon first", async () => {
  const result = await callTool("search_sermons", { query: "anxiety about my marriage" });
  const s = result.structuredContent;
  assert.ok(s.resultCount >= 1);
  assert.equal(s.results[0].sermonId, "s-marriage-001");
  assert.equal(s.interpretedIntent.requiredSubject, "marriage");
  assert.ok(s.interpretedIntent.supportiveNeeds.includes("anxiety"));
  assert.ok(!s.results.some((r) => r.sermonId === "s-money-001"), "passing-mention money sermon must not qualify in strict mode");
  assert.ok(s.appliedFilters.some((f) => f.includes("strict")), "appliedFilters names the strict filter");
  assert.ok(s.suggestedQueries.length > 0, "suggestedQueries always returned");
  const top = s.results[0];
  assert.ok(top.thesis.length > 20, "thesis present for agent judging");
  assert.equal(top.preacher, "Pastor Taylor Wilkerson");
  assert.equal(top.durationSeconds, 2280);
  for (const r of s.results) assert.match(r.youtubeUrl, YT_RE, "no timestamp params");
  assert.ok(result.content[0].text.includes(top.title), "text fallback agrees with structured output");
});

test("search_sermons: broad mode keeps adjacent sermons", async () => {
  const result = await callTool("search_sermons", {
    query: "anxiety about my marriage",
    matchMode: "broad",
  });
  const s = result.structuredContent;
  assert.ok(s.resultCount >= 1);
  assert.equal(s.results[0].sermonId, "s-marriage-001", "primary-topic match still ranks first");
  assert.ok(s.appliedFilters.some((f) => f.includes("broad")));
});

test("search_sermons: unknown topic returns honest empty result", async () => {
  const result = await callTool("search_sermons", { query: "quantum computing ethics" });
  const s = result.structuredContent;
  assert.equal(s.resultCount, 0);
  assert.deepEqual(s.results, []);
  assert.ok(s.appliedFilters.some((f) => f.includes("overlap floor")), "empty explained by overlap floor");
  assert.equal(result.isError, undefined);
});

test("search_sermons: long verbatim queries accepted (up to 2000 chars)", async () => {
  const result = await callTool("search_sermons", {
    query: "my husband and I keep fighting about small things and I am scared we are drifting apart, it has been six months of this",
  });
  assert.equal(result.structuredContent.results[0].sermonId, "s-marriage-001");
});

test("search_sermons: invalid inputs produce tool errors", async () => {
  for (const args of [
    { query: "ab" },
    { query: "x".repeat(2001) },
    { query: "marriage", limit: 99 },
    { query: "marriage", matchMode: "sideways" },
    { query: "marriage", bogus: 1 },
  ]) {
    const result = await callTool("search_sermons", args);
    assert.equal(result.isError, true, `expected error for ${JSON.stringify(args).slice(0, 60)}`);
  }
});

test("get_sermon: full profile for a known id", async () => {
  const result = await callTool("get_sermon", { sermonId: "s-grief-001" });
  const s = result.structuredContent.sermon;
  assert.equal(s.title, "When Sorrow Stays: Grieving with Hope");
  assert.match(s.youtubeUrl, YT_RE);
  assert.ok(s.thesis.length > 0 && s.primaryTopics.length > 0 && s.scriptures.length > 0);
  assert.equal(s.preacher, "Pastor Kristen Wilkerson");
  assert.equal(s.durationSeconds, 2100);
  assert.ok(s.keyQuotes.length >= 1, "key quotes give the agent the sermon's voice");
  assert.ok(result.content[0].text.includes(s.keyQuotes[0].slice(0, 30)), "text fallback carries a quote");
});

test("get_sermon: unknown id returns SERMON_NOT_FOUND", async () => {
  const result = await callTool("get_sermon", { sermonId: "nope" });
  assert.equal(result.isError, true);
  assert.ok(result.content[0].text.includes("SERMON_NOT_FOUND"));
});

test("list_recent_sermons: newest first, limit honoured", async () => {
  const all = await callTool("list_recent_sermons", {});
  assert.equal(all.structuredContent.sermons.length, 4);
  const dates = all.structuredContent.sermons.map((s) => s.publishedAt);
  assert.deepEqual(dates, [...dates].sort().reverse());
  const two = await callTool("list_recent_sermons", { limit: 2 });
  assert.equal(two.structuredContent.sermons.length, 2);
});

test("concurrent requests with repeated JSON-RPC ids never cross responses", async () => {
  const ids = ["s-marriage-001", "s-grief-001", "s-money-001", "s-anxiety-work-001", "nope"];
  const results = await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      callTool("get_sermon", { sermonId: ids[i % ids.length] }, 42)
    )
  );
  results.forEach((r, i) => {
    const want = ids[i % ids.length];
    if (want === "nope") {
      assert.equal(r.isError, true);
    } else {
      assert.equal(r.structuredContent.sermon.sermonId, want, `response ${i} crossed`);
    }
  });
});

test("list_series: returns series most recent first", async () => {
  const result = await callTool("list_series", {});
  const series = result.structuredContent.series;
  assert.ok(series.length >= 2, "expected at least Foundations and Treasure");
  const names = series.map((s) => s.name);
  assert.ok(names.includes("Foundations"));
  assert.ok(names.includes("Treasure"));
  // Most recent first: Treasure (2023-11-05) vs Foundations (2024-02-11)
  assert.equal(names[0], "Foundations");
  for (const s of series) {
    assert.ok(s.sermonCount >= 1);
    assert.ok(s.firstPreached <= s.lastPreached);
  }
});

test("list_series_sermons: chronological order, honest empty", async () => {
  const result = await callTool("list_series_sermons", { series: "Foundations" });
  assert.equal(result.structuredContent.series, "Foundations");
  assert.ok(result.structuredContent.sermons.length >= 1);
  const dates = result.structuredContent.sermons.map((s) => s.publishedAt);
  assert.deepEqual(dates, [...dates].sort());

  // Case-insensitive
  const lower = await callTool("list_series_sermons", { series: "foundations" });
  assert.equal(lower.structuredContent.series, "Foundations");

  // Unknown -> empty + suggestions
  const missing = await callTool("list_series_sermons", { series: "Nonexistent Series XYZ" });
  assert.equal(missing.structuredContent.sermons.length, 0);
  assert.ok(missing.structuredContent.suggestedSeries.length > 0);
});

test("find_similar_sermons: excludes self, unknown id -> empty", async () => {
  const result = await callTool("find_similar_sermons", { sermonId: "s-marriage-001" });
  assert.equal(result.structuredContent.sourceSermon.sermonId, "s-marriage-001");
  for (const s of result.structuredContent.sermons) {
    assert.notEqual(s.sermonId, "s-marriage-001", "self must be excluded");
  }
  const missing = await callTool("find_similar_sermons", { sermonId: "nope" });
  assert.equal(missing.structuredContent.sermons.length, 0);
  assert.equal(missing.structuredContent.sourceSermon, null);
});

test("resources/list exposes the faith-assistant skill", async () => {
  const resp = await rpc("resources/list", {});
  const uris = resp.result.resources.map((r) => r.uri);
  assert.ok(uris.includes("skill://trinity-sermons/faith-assistant"));
  const read = await rpc("resources/read", {
    uri: "skill://trinity-sermons/faith-assistant",
  });
  const text = read.result.contents[0].text;
  assert.ok(text.includes("Never invent quotes"));
  assert.ok(text.includes("search_sermons"));
});
