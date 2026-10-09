// Reranking + calibrated relevance gate.
//
// The Cohere adapter (rerank-v4.0-fast) is wired once COHERE_API_KEY exists;
// the in-memory reranker below is a deterministic stand-in for tests and
// offline development. The gate — threshold from config/retrieval.json,
// exact-tie break by fused candidate score then publication date — is real
// and shared by both.

import type { InterpretedIntent } from "./intent.js";
import type { SermonRecord } from "../sermons/types.js";
import type { Candidate } from "./candidates.js";

export interface RerankedCandidate extends Candidate {
  rerankScore: number;
}

export interface Reranker {
  rerank(
    originalQuery: string,
    intent: InterpretedIntent,
    candidates: Candidate[]
  ): Promise<RerankedCandidate[]>;
}

function normTopic(t: string): string {
  return t.toLowerCase().trim();
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9']+/)
    .filter((t) => t.length > 2);
}

/** Fraction of query tokens appearing in the sermon document. */
function tokenOverlap(query: string, doc: string): number {
  const q = new Set(tokenize(query));
  if (q.size === 0) return 0;
  const d = new Set(tokenize(doc));
  let hits = 0;
  for (const t of q) if (d.has(t)) hits += 1;
  return hits / q.size;
}

/**
 * Deterministic stand-in scorer. Ranks whether the COMPLETE sermon addresses
 * the request: the required subject must be a primary topic to score highly,
 * a passing mention scores near zero, supportive needs only nudge ordering.
 */
export class InMemoryReranker implements Reranker {
  async rerank(
    _originalQuery: string,
    intent: InterpretedIntent,
    candidates: Candidate[]
  ): Promise<RerankedCandidate[]> {
    return candidates.map((c) => {
      const primary = c.sermon.profile.primaryTopics.map(normTopic);
      const secondary = c.sermon.profile.secondaryTopics.map(normTopic);
      const needs = new Set([...intent.supportiveNeeds.map(normTopic)]);
      let score: number;
      if (intent.requiredSubject === null && needs.size === 0) {
        // No subject signal at all: score on literal token overlap so
        // genuinely unrelated queries (e.g. "quantum computing ethics")
        // fall below the gate instead of passing at a flat 0.5.
        score = 0.05 + 0.55 * tokenOverlap(_originalQuery, c.sermon.retrievalText);
      } else if (intent.requiredSubject === null) {
        // No hard subject: rank on supportive-need and topic overlap.
        const all = new Set([...primary, ...secondary]);
        const hits = [...needs].filter((n) => all.has(n)).length;
        score = needs.size === 0 ? 0.5 : 0.3 + 0.2 * Math.min(hits, 2);
      } else if (primary.includes(normTopic(intent.requiredSubject))) {
        score = 0.9;
      } else if (secondary.includes(normTopic(intent.requiredSubject))) {
        score = 0.45;
      } else {
        score = 0.05; // passing mention at best — the gate drops it
      }
      const all = new Set([...primary, ...secondary]);
      const needHits = [...needs].filter((n) => all.has(n)).length;
      score = Math.min(1, score + 0.05 * needHits);
      return { ...c, rerankScore: score };
    });
  }
}

/** Apply the calibrated gate; ties break by fused score, then newest first. */
export function applyRelevanceGate(
  reranked: RerankedCandidate[],
  threshold: number,
  limit: number
): RerankedCandidate[] {
  return reranked
    .filter((c) => c.rerankScore >= threshold)
    .sort(
      (a, b) =>
        b.rerankScore - a.rerankScore ||
        b.fusedScore - a.fusedScore ||
        (a.sermon.publishedAt < b.sermon.publishedAt ? 1 : -1)
    )
    .slice(0, limit);
}
