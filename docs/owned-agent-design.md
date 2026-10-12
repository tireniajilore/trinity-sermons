# Trinity owned sermon agent — design and implementation

Status: implemented v1 on `feat/grounded-sermon-agent`; deployment and live semantic evaluation are separate release steps.

## Goal

Help people discover and read Trinity New York sermons without producing unsourced spiritual advice. The application owns retrieval, evidence review and presentation. The model cannot publish free-form answers. Existing MCP functions remain available for compatibility; the new product uses internal services directly.

## Product scope

V1 supports topic/situation search, exploring teaching through source excerpts, and checking a supplied quotation. The first-party web interface is GET `/`; POST `/api/agent` accepts `{question}` and returns controlled response blocks. It requires the real database and model configuration: fixture sermons are never exposed through this endpoint.

Personal prescriptions, claims about God's intentions for the individual, and newly composed prayers receive a fixed boundary response. Ambiguous conversational references, metadata-only requests, series browsing, whole-year summaries and similar-sermon workflows receive a clarification/feature-limit response. They are explicit follow-on work, not silently simulated. There is no persistent conversation memory in v1. Users supply the topic or sermon title again.

## Invariants

1. Displayed quotations/excerpts are exact slices of a stored transcript, not generated profile keyQuotes. Evidence carries sermon ID, transcript version, source and offsets.
2. The model can return only a bounded plan, existing passage IDs, fit enums and review decisions. Extra fields, malformed JSON and unknown selection IDs fail closed.
3. Canonical title, preacher, publication date and video link are loaded by application code. Publication date is never relabelled as preaching date.
4. Every displayed excerpt requires an independent review call. Unknown review IDs cannot add cards. No free-form model text is rendered.
5. Before release, reread the source and record: deleted/suppressed/changed sources are dropped. A source failure never becomes an empty-corpus assertion.
6. At most three searches, twelve transcript candidates, four passages per candidate and three cards per answer. At most three model calls (plan, select, review); no repair loop in v1.
7. Deadline/provider/schema failure returns an unavailable response without partial cards. Insufficient evidence is a successful explicit limitation.
8. The browser inserts dynamic content as text, never HTML or Markdown, and permits only canonical YouTube watch links.

## Workflow and responsibility

The planner classifies a request and proposes up to two rewrites. The controller always searches the original query too. Candidate retrieval reuses the hybrid provider directly, avoiding the old alias-based exclusion and fail-open reranker. Candidate profiles are discovery hints only. No profile statement becomes user-visible evidence.

The controller fetches transcripts for bounded candidates, splits into overlapping 1,200-character windows and ranks windows by query word overlap. The selector chooses up to three passage IDs and a direct/related label. The reviewer independently checks the ORIGINAL request, canonical metadata, passage content, contextual suitability, fit and all explicit constraints. It rejects misleading snippets, injection and personally prescriptive framing. It does not write prose.

The renderer produces fixed explanatory text plus cards. “Direct” means the excerpt addresses the query, not that the entire sermon is about it. The response explicitly disclaims a complete statement of Trinity's position and identifies caption uncertainty. Each card links to the full sermon, with ellipses marking excerpts.

Quote verification requires the complete target to occur in the checked source, allowing case and whitespace normalization only. If a double-quoted target is present in the user's request, the planner cannot substitute a shorter fragment. Unverified means not verified in the checked sources, never “the preacher did not say this.”

## What is guaranteed, and what isn't

Exact source copying, metadata provenance, schema restrictions and required review are enforced by code. Relevance, classification, context interpretation and assessing whether an excerpt implies advice remain model judgments. Two calls to the same model are not independent guarantees of truth. A transcript may itself be wrong or contain harmful/injected material. Source fidelity does not establish theological correctness. This design reduces exposure by publishing no model-written faith claims.

The passage search is intentionally bounded and can miss paraphrases or quotations crossing chunk boundaries. There is no complete-corpus coverage claim. Explicit preacher/date/scripture restrictions are assessed by selector and reviewer in v1; they are not yet a deterministic structured filter API. Live evaluation must test these before release.

## Operations

Existing `DATABASE_URL` and `OPENAI_API_KEY` configure the service. `AGENT_MODEL` optionally selects the model (default matches the existing mini-model integration). Overall request deadline is 45 seconds; model requests receive its abort signal. The API caps active agent requests at four in addition to existing IP rate limiting. Responses use `Cache-Control: no-store`. User queries and transcripts are sent to the configured model provider but are not newly logged or persisted by this feature. Traces contain counts and a random request ID, not raw user text. The UI replaces results on each request.

MCP remains as a compatibility route, with its existing semantics. Its profile-based verification must not be confused with the owned agent's transcript evidence. Removing MCP can follow a deliberate client migration. Deploying this branch changes `/` to the agent UI.

## Evaluation

The previous runner used text-only truncated MCP results and loose URL/quote heuristics. Its scores are not comparable to the owned-agent tests. Retain it only as a legacy baseline.

`npm run evaluate:agent` runs deterministic adversarial harness tests with injected model/provider outputs: invented evidence, extra advice fields, review rejection, absent/changed/suppressed transcripts, timeouts, provider failure, invented reviewer IDs, full-quote mismatch and source deduplication. These verify enforcement, not live model quality.

`npm run evaluate:agent:live` runs the 14 existing behavior questions plus new advice/adversarial cases through the actual API. It prints one JSON record per case, full response and latency for review; it checks response structure and forbidden free-form fields, but does not pretend those checks grade semantic accuracy. Configure `AGENT_EVAL_URL` to the instance under test. Do not point at a public instance without a controlled test budget.

Before release, use a versioned production corpus with human-labelled relevance and source spans. Complete the eight nonempty queries without positive labels in `labelled-queries.json`. Measure candidate recall at the candidate stage, recommendation precision, abstention, speaker/date restrictions, complete quote fidelity, contextual integrity, boundary handling, cost and latency. Add held-out and repeated-run cases. Hard invariants must pass all tests; semantic acceptance requires human review of the live outputs. No claim of 100% hallucination prevention is justified.

## Next increments

1. Improve passage retrieval with semantic passage search and sentence/segment boundaries; retain source offsets.
2. Add structured catalog filters and title resolution, then series/similarity routes and explicit conversation state.
3. Introduce short generated explanations only after claim-to-passage support grading passes a held-out corpus; keep direct quotations and metadata application-rendered.
4. Add full-year coverage-aware aggregation only when catalog coverage can be established.
