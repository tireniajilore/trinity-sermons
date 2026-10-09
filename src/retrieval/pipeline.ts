// Search orchestration in one place: intent -> candidates -> rerank -> gate.
// Nothing ranking-related lives in the MCP tool, the route handler, or the
// database client.

import { loadRetrievalConfig, type RetrievalConfig } from "../config.js";
import { interpretQuery, normalizeQuery, type InterpretedIntent } from "./intent.js";
import { InMemoryCandidateProvider, type CandidateProvider } from "./candidates.js";
import { InMemoryReranker, applyRelevanceGate, type Reranker } from "./rerank.js";
import { SearchCache } from "./cache.js";
import { InMemorySermonRepository, type SermonRepository } from "../sermons/repository.js";
import { youtubeUrl, type SermonRecord } from "../sermons/types.js";

export interface SearchResultItem {
  sermonId: string;
  title: string;
  publishedAt: string;
  blurb: string;
  primaryTopics: string[];
  youtubeUrl: string;
}

export interface SearchPayload {
  query: string;
  interpretedIntent: { requiredSubject: string | null; supportiveNeeds: string[] };
  resultCount: number;
  results: SearchResultItem[];
  suggestedQueries: string[];
}

export interface PipelineDeps {
  repository: SermonRepository;
  candidateProvider: CandidateProvider;
  reranker: Reranker;
  cache: SearchCache<SearchPayload>;
  config: RetrievalConfig;
}

export function defaultPipelineDeps(): PipelineDeps {
  return {
    repository: new InMemorySermonRepository(),
    candidateProvider: new InMemoryCandidateProvider(),
    reranker: new InMemoryReranker(),
    cache: new SearchCache<SearchPayload>(),
    config: loadRetrievalConfig(),
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
  };
}

/** Zero-result fallback: up to three simpler queries to try instead. */
export function suggestedQueriesFor(intent: InterpretedIntent, query: string): string[] {
  const out: string[] = [];
  if (intent.requiredSubject) out.push(intent.requiredSubject);
  for (const need of intent.supportiveNeeds) {
    if (out.length >= 3) break;
    if (!out.includes(need)) out.push(need);
  }
  if (out.length === 0) {
    const words = query.split(" ").filter(Boolean);
    if (words.length > 1) out.push(words.slice(0, Math.min(3, words.length)).join(" "));
  }
  return out.slice(0, 3);
}

export async function runSearch(
  deps: PipelineDeps,
  rawQuery: string,
  limit: number
): Promise<SearchPayload> {
  const query = normalizeQuery(rawQuery);
  const cacheKey = deps.cache.key({
    query: query.toLowerCase(),
    limit,
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
  const reranked = await deps.reranker.rerank(query, intent, candidates);
  const gated = applyRelevanceGate(reranked, deps.config.relevanceThreshold, limit);

  const payload: SearchPayload = {
    query,
    interpretedIntent: {
      requiredSubject: intent.requiredSubject,
      supportiveNeeds: intent.supportiveNeeds,
    },
    resultCount: gated.length,
    results: gated.map((c) => toResultItem(c.sermon)),
    suggestedQueries: gated.length === 0 ? suggestedQueriesFor(intent, query) : [],
  };
  deps.cache.set(cacheKey, payload);
  return payload;
}
