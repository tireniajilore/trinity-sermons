# Trinity Sermons

## Owned sermon agent

The first-party interface at `/` now searches and displays reviewed transcript
excerpts. `POST /api/agent` accepts `{ "question": "Find sermons about grief" }`.
The model selects sources; application code publishes canonical metadata and exact
transcript slices. It cannot publish free-form advice or generated prayers.

Requires `DATABASE_URL` and `OPENAI_API_KEY`; optional `AGENT_MODEL` defaults to
`gpt-4o-mini`. Missing configuration returns 503, never demonstration sermons.
The `/mcp` route remains available for existing clients.

- [Design, invariants, limitations and release plan](docs/owned-agent-design.md)
- `npm run evaluate:agent` — offline enforcement tests
- `AGENT_EVAL_URL=http://127.0.0.1:3000 npm run evaluate:agent:live` — live traces
  for human relevance, attribution and boundary review; not a semantic score

V1 supports discovery and quote checking. Catalog summaries, conversation memory,
and generated teaching synthesis are deferred. Model review can still misjudge
relevance or context; transcript fidelity is not proof of theological correctness.

## Legacy MCP interface

A public, read-only MCP server that finds **complete Trinity New York sermons**
(@TrinityNewYork, Harlem) matching a topic or life situation — then returns a
short blurb and a YouTube link that starts at the beginning.

- MCP endpoint (Streamable HTTP, stateless): `POST /mcp`
- Health: `GET /healthz`
- Tools: `search_sermons`, `get_sermon`, `list_recent_sermons` — all read-only,
  deterministic in shape, safe to retry.

## How retrieval works

Designed for agents: the server retrieves broadly and filters transparently,
the agent judges. Whole-sermon profiles (thesis, topics, audience needs,
key quotes) are generated offline with OpenAI and embedded with
`text-embedding-3-small` (1536 dims). At query time: deterministic alias
parsing establishes the *required* subject from the user's own words, dense
top-50 + lexical top-50 go through weighted reciprocal-rank fusion, then a
deterministic whole-sermon filter drops passing mentions (strict mode:
subject must be a primary topic) and an overlap floor keeps unknown topics
honestly empty. No reranker — the agent reads blurbs, theses, and quotes and
decides. `appliedFilters` and always-on `suggestedQueries` give the agent its
iteration loop (`matchMode: "broad"` retries).

## Develop

```bash
npm install
npm test          # build + MCP contract tests (in-memory fixtures, no keys)
npm run dev       # watch mode on :3000
```

`SermonRepository`, `CandidateProvider`, and `QueryEmbedder` are interfaces —
Postgres/OpenAI adapters slot in when `DATABASE_URL` and `OPENAI_API_KEY`
exist. Until then the in-memory fakes serve the fixture corpus.

```bash
npm run ingest          # YouTube captions -> sermon_transcripts (needs DATABASE_URL)
npm run build-profiles  # OpenAI profiles + embeddings, atomic publish (needs OPENAI_API_KEY)
npm run evaluate        # eval set metrics against the release gates
```

## Spec adaptations

The design doc targets Vercel + Next.js + Supabase + Gemini + Cohere. This
repo ships on Railway instead (same shape as nycfoodie): plain Node HTTP
replaces the Next.js route shell, `db/migrations` is database-neutral
Postgres (pgvector) running on Railway Postgres, OpenAI replaces Gemini
(single vendor — the key already exists), and the Cohere reranker is replaced
by a deterministic whole-sermon filter since the agent is the judge.

## Release gates

Candidate Recall@30 ≥ 98% · Precision@3 ≥ 85% · qualification precision ≥ 95% ·
zero-result accuracy ≥ 90% · false-positive rate ≤ 5%. Measured with
`npm run evaluate` against `evals/retrieval-cases.ts`.
