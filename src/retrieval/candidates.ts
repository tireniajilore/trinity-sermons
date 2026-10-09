// Candidate generation: dense top-N + lexical top-N, weighted reciprocal-rank
// fusion (k=60, dense 0.65 / lexical 0.35), deduplicated, best-M kept.
// Optimized for recall — the final relevance threshold is applied later, by
// the reranker gate, never here.
//
// The Postgres implementation calls the hybrid_search_sermon_profiles RPC.
// The in-memory provider below scores token overlap on the labelled retrieval
// document; it exists so the pipeline, fusion, and tests run without keys.

import type { InterpretedIntent } from "./intent.js";
import type { SermonRecord } from "../sermons/types.js";

export interface Candidate {
  sermon: SermonRecord;
  fusedScore: number;
}

export interface CandidateProvider {
  candidates(
    intent: InterpretedIntent,
    sermons: SermonRecord[],
    counts: { dense: number; lexical: number; fused: number },
    fusion: { k: number; denseWeight: number; lexicalWeight: number }
  ): Promise<Candidate[]>;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9']+/)
    .filter((t) => t.length > 2);
}

/** Weighted reciprocal-rank fusion of two ranked id lists. */
export function weightedRRF(
  denseRanked: string[],
  lexicalRanked: string[],
  k: number,
  denseWeight: number,
  lexicalWeight: number
): Array<{ id: string; score: number }> {
  const scores = new Map<string, number>();
  const add = (ids: string[], weight: number) => {
    ids.forEach((id, rank) => {
      scores.set(id, (scores.get(id) ?? 0) + weight / (k + rank + 1));
    });
  };
  add(denseRanked, denseWeight);
  add(lexicalRanked, lexicalWeight);
  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
}

export class InMemoryCandidateProvider implements CandidateProvider {
  async candidates(
    intent: InterpretedIntent,
    sermons: SermonRecord[],
    counts: { dense: number; lexical: number; fused: number },
    fusion: { k: number; denseWeight: number; lexicalWeight: number }
  ): Promise<Candidate[]> {
    const queryTokens = new Set(tokenize(intent.retrievalQuery));
    const score = (s: SermonRecord): number => {
      const docTokens = tokenize(s.retrievalText);
      let hits = 0;
      for (const t of docTokens) if (queryTokens.has(t)) hits += 1;
      return hits / Math.sqrt(docTokens.length);
    };
    // Dense stand-in: overlap over the whole labelled document (recall-heavy).
    const denseRanked = [...sermons]
      .sort((a, b) => score(b) - score(a))
      .slice(0, counts.dense)
      .map((s) => s.sermonId);
    // Lexical stand-in: overlap restricted to primary topics + title.
    const lexScore = (s: SermonRecord): number => {
      const docTokens = tokenize(`${s.title} ${s.profile.primaryTopics.join(" ")}`);
      let hits = 0;
      for (const t of docTokens) if (queryTokens.has(t)) hits += 1;
      return hits;
    };
    const lexicalRanked = [...sermons]
      .sort((a, b) => lexScore(b) - lexScore(a))
      .slice(0, counts.lexical)
      .map((s) => s.sermonId);

    const fused = weightedRRF(
      denseRanked,
      lexicalRanked,
      fusion.k,
      fusion.denseWeight,
      fusion.lexicalWeight
    ).slice(0, counts.fused);
    const byId = new Map(sermons.map((s) => [s.sermonId, s]));
    return fused
      .map(({ id, score: fusedScore }) => ({ sermon: byId.get(id)!, fusedScore }))
      .filter((c) => c.sermon !== undefined);
  }
}
