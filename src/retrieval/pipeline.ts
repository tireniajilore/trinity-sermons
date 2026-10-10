// Search orchestration in one place: intent -> candidates -> deterministic
// whole-sermon filter -> overlap floor. No model reranker: the agent is the
// judge, the server retrieves broadly and filters transparently.

import { loadRetrievalConfig, type RetrievalConfig } from "../config.js";
import { interpretQuery, normalizeQuery, type InterpretedIntent } from "./intent.js";
import { InMemoryCandidateProvider, type CandidateProvider } from "./candidates.js";
import { applyWholeSermonFilter, type MatchMode } from "./filter.js";
import { SearchCache } from "./cache.js";
import { InMemorySermonRepository, type SermonRepository } from "../sermons/repository.js";
import {
  createDbPool,
  NullEmbedder,
  PostgresCandidateProvider,
  PostgresSermonRepository,
  type QueryEmbedder,
} from "../providers/postgres.js";
import { OpenAIEmbedder } from "../providers/openai.js";
import { youtubeUrl, type SermonRecord } from "../sermons/types.js";

export interface SearchResultItem {
  sermonId: string;
  title: string;
  publishedAt: string;
  blurb: string;
  primaryTopics: string[];
  youtubeUrl: string;
  thesis: string;
  preacher: string | null;
  durationSeconds: number | null;
}

export interface SearchPayload {
  query: string;
  interpretedIntent: { requiredSubject: string | null; supportiveNeeds: string[] };
  appliedFilters: string[];
  resultCount: number;
  results: SearchResultItem[];
  suggestedQueries: string[];
}

export interface PipelineDeps {
  repository: SermonRepository;
  candidateProvider: CandidateProvider;
  cache: SearchCache<SearchPayload>;
  config: RetrievalConfig;
}

function queryEmbedder(): QueryEmbedder {
  return process.env.OPENAI_API_KEY ? new OpenAIEmbedder() : new NullEmbedder();
}

export function defaultPipelineDeps(): PipelineDeps {
  const config = loadRetrievalConfig();
  const cache = new SearchCache<SearchPayload>();
  // Postgres when DATABASE_URL is set (production); in-memory fixtures
  // otherwise (local dev, contract tests, offline evaluation).
  const pool = createDbPool();
  if (pool) {
    return {
      repository: new PostgresSermonRepository(pool),
      candidateProvider: new PostgresCandidateProvider(pool, queryEmbedder()),
      cache,
      config,
    };
  }
  return {
    repository: new InMemorySermonRepository(),
    candidateProvider: new InMemoryCandidateProvider(),
    cache,
    config,
  };
}

function toResultItem(s: SermonRecord): SearchResultItem {
  return {
    sermonId: s.sermonId,
    title: s.title,
    publishedAt: s.publishedAt,
    blurb: s.profile.shortBlurb,
    primaryTopics: s.profile.primaryTopics,
    youtubeUrl: youtubeUrl(s.youtubeVideoId),
    thesis: s.profile.thesis,
    preacher: s.preacher,
    durationSeconds: s.durationSeconds,
  };
}

/** Simpler queries to try — always returned, fuels the agent's iteration. */
export function suggestedQueriesFor(intent: InterpretedIntent): string[] {
  const out: string[] = [];
  if (intent.requiredSubject) out.push(intent.requiredSubject);
  for (const need of intent.supportiveNeeds) {
    if (out.length >= 3) break;
    if (!out.includes(need)) out.push(need);
  }
  return out.slice(0, 3);
}

export async function runSearch(
  deps: PipelineDeps,
  rawQuery: string,
  limit: number,
  matchMode: MatchMode = "strict"
): Promise<SearchPayload> {
  const query = normalizeQuery(rawQuery);
  const cacheKey = deps.cache.key({
    query: query.toLowerCase(),
    limit,
    matchMode,
    pipelineVersion: deps.config.pipelineVersion,
    corpusGeneration: deps.config.corpusGeneration,
  });
  const cached = deps.cache.get(cacheKey);
  if (cached) return cached;

  const intent = await interpretQuery(query);
  const sermons = await deps.repository.listAll();
  const candidates = await deps.candidateProvider.candidates(
    intent,
    sermons,
    deps.config.candidateCounts,
    deps.config.fusion
  );
  const { kept, appliedFilters } = applyWholeSermonFilter(
    candidates,
    intent,
    matchMode,
    deps.config.overlapFloor,
    deps.config.denseMaxDistance ?? null
  );
  const limited = kept.slice(0, limit);

  const payload: SearchPayload = {
    query,
    interpretedIntent: {
      requiredSubject: intent.requiredSubject,
      supportiveNeeds: intent.supportiveNeeds,
    },
    appliedFilters,
    resultCount: limited.length,
    results: limited.map((c) => toResultItem(c.sermon)),
    suggestedQueries: suggestedQueriesFor(intent),
  };
  deps.cache.set(cacheKey, payload);
  return payload;
}
