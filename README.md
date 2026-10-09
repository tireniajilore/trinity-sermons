# Trinity Sermons MCP

A public, read-only MCP server that finds **complete Trinity New York sermons**
(@TrinityNewYork, Harlem) matching a topic or life situation — then returns a
short blurb and a YouTube link that starts at the beginning.

- MCP endpoint (Streamable HTTP, stateless): `POST /mcp`
- Health: `GET /healthz`
- Tools: `search_sermons`, `get_sermon`, `list_recent_sermons` — all read-only,
  deterministic in shape, safe to retry.

## How retrieval works

Whole-sermon profiles (thesis, topics, audience needs, framework, scriptures)
are generated offline with Gemini 2.5-flash and embedded with
gemini-embedding-2. At query time: deterministic alias parsing establishes the
*required* subject from the user's own words, dense top-50 + lexical top-50 go
through weighted reciprocal-rank fusion, Cohere reranks the top 30, and a
calibrated gate drops everything uncertain. Empty results beat weak results.

## Develop

```bash
npm install
npm test          # build + MCP contract tests (in-memory fixtures, no keys)
npm run dev       # watch mode on :3000
```

Copy the pattern for real providers: `SermonRepository`, `CandidateProvider`,
and `Reranker` are interfaces — Postgres/Gemini/Cohere adapters slot in once
`DATABASE_URL`, `GEMINI_API_KEY`, and `COHERE_API_KEY` exist. Until then the
in-memory fakes serve the fixture corpus.

```bash
npm run ingest          # YouTube captions -> sermon_transcripts (needs DATABASE_URL)
npm run build-profiles  # Gemini profiles + embeddings, atomic publish (needs GEMINI_API_KEY)
npm run evaluate        # eval set metrics + threshold calibration sweep
```

## Spec adaptations

The design doc targets Vercel + Next.js + Supabase. This repo ships on Railway
instead (same shape as nycfoodie): plain Node HTTP replaces the Next.js route
shell, and `db/migrations` is database-neutral Postgres (pgvector) so it runs
on Railway Postgres or Supabase unchanged.

## Release gates

Candidate Recall@30 ≥ 98% · Precision@3 ≥ 85% · qualification precision ≥ 95% ·
zero-result accuracy ≥ 90% · false-positive rate ≤ 5%. Measured with
`npm run evaluate` against `evals/retrieval-cases.ts`.
