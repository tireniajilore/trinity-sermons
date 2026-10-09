// Deterministic whole-sermon filter — replaces the model reranker.
//
// The agent is the judge; the server's job is transparent, predictable
// filtering. Per candidate, keep when ANY of these hold:
//   1. strict mode + the explicit required subject is a primary topic
//      (the user's own words are the strongest evidence — no lexical
//      overlap needed, so semantic matches survive);
//   2. fuzzy lexical overlap between query and profile >= overlapFloor
//      (catches misspellings via edit distance; drops total garbage).
// No model calls, no calibrated scores. A future dense-similarity
// OR-condition can be added here once real embeddings are calibrated
// (TODO post-backfill).

import type { InterpretedIntent } from "./intent.js";
import { ALIAS_MAP } from "./intent.js";
import type { Candidate } from "./candidates.js";

export type MatchMode = "strict" | "broad";

export interface FilterResult {
  kept: Candidate[];
  appliedFilters: string[];
}

const STOPWORDS = new Set(
  "a,an,and,are,as,at,about,be,been,but,by,for,from,has,have,had,he,she,it,its,in,into,is,of,on,or,that,the,their,them,they,this,to,was,were,with,you,your,we,our,us,my,me,him,her,his,they,what,when,where,who,how,why,not,no,do,does,all,any,can,just,than,then,there,these,those,will,would,should,could,i".split(
    ","
  )
);

function normTopic(t: string): string {
  return t.toLowerCase().trim();
}

function contentTokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9']+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

/** Edit distance with early exit past maxDist. */
function levWithin(a: string, b: string, maxDist: number): boolean {
  if (a === b) return true;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > maxDist) return false;
  let prev = Array.from({ length: lb + 1 }, (_, j) => j);
  for (let i = 1; i <= la; i++) {
    let cur = i;
    let rowMin = i;
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const next = Math.min(prev[j] + 1, cur + 1, prev[j - 1] + cost);
      prev[j - 1] = cur;
      cur = next;
      if (next < rowMin) rowMin = next;
    }
    prev[lb] = cur;
    if (rowMin > maxDist) return false;
  }
  return prev[lb] <= maxDist;
}

/** Single adjacent transposition (the classic "marraige" misspelling). */
function isTransposition(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  if (i >= a.length - 1) return false;
  return (
    a[i] === b[i + 1] &&
    a[i + 1] === b[i] &&
    a.slice(i + 2) === b.slice(i + 2)
  );
}

function fuzzyWordMatch(t: string, w: string): boolean {
  if (t === w) return true;
  if (t.length < 4 || w.length < 4) return false;
  return levWithin(t, w, 1) || isTransposition(t, w);
}

/**
 * Fraction of query content-words with an exact or near match in the
 * document. Near = edit distance <= 1 or a single transposition, for words
 * of length >= 4 — catches misspellings like "marraige" without stemming
 * the whole pipeline.
 */
export function fuzzyOverlap(query: string, doc: string): number {
  const q = contentTokens(query);
  if (q.length === 0) return 0;
  const d = new Set(contentTokens(doc));
  let hits = 0;
  for (const t of q) {
    if (d.has(t)) {
      hits += 1;
      continue;
    }
    for (const w of d) {
      if (fuzzyWordMatch(t, w)) {
        hits += 1;
        break;
      }
    }
  }
  return hits / q.length;
}

/**
 * Word-level subject match against primary topics. The old exact-string check
 * almost never fired (330 messy topic strings like "Hope and Encouragement").
 * Now: keep when the canonical subject or any of its trigger words appears
 * as a whole word inside any primary topic.
 */
function subjectInPrimaryTopics(subject: string, primaryTopics: string[]): boolean {
  const triggers = [subject, ...(ALIAS_MAP[subject] ?? [])];
  const topicWords = new Set(
    primaryTopics.flatMap((t) => normTopic(t).split(/[^a-z0-9']+/))
  );
  return triggers.some((w) => topicWords.has(w.toLowerCase()));
}

export function applyWholeSermonFilter(
  candidates: Candidate[],
  intent: InterpretedIntent,
  matchMode: MatchMode,
  overlapFloor: number
): FilterResult {
  const appliedFilters: string[] = [];
  const subject = intent.requiredSubject ? normTopic(intent.requiredSubject) : null;

  // Broad mode: primary-topic matches first, then secondary, then the rest.
  let ordered = candidates;
  if (subject && matchMode === "broad") {
    const rank = (c: Candidate): number => {
      if (subjectInPrimaryTopics(subject, c.sermon.profile.primaryTopics)) return 0;
      const secondary = c.sermon.profile.secondaryTopics.map(normTopic);
      if (secondary.some((t) => t.includes(subject))) return 1;
      return 2;
    };
    ordered = [...candidates].sort((a, b) => rank(a) - rank(b) || b.fusedScore - a.fusedScore);
    appliedFilters.push(`ranked by '${intent.requiredSubject}' topic placement (broad)`);
  }

  let droppedBySubject = 0;
  let droppedByFloor = 0;
  const kept = ordered.filter((c) => {
    // 1. Explicit subject in primary topics (strict): hard gate.
    //    Word-level match via subjectInPrimaryTopics (not exact string),
    //    so messy topic strings like "Hope and Encouragement" still match.
    if (subject && matchMode === "strict") {
      if (subjectInPrimaryTopics(subject, c.sermon.profile.primaryTopics)) return true;
      droppedBySubject += 1;
      return false;
    }
    // 2. Fuzzy lexical overlap floor.
    if (fuzzyOverlap(intent.retrievalQuery, c.sermon.retrievalText) >= overlapFloor) return true;
    droppedByFloor += 1;
    return false;
  });

  if (subject && matchMode === "strict") {
    appliedFilters.push(
      `required '${intent.requiredSubject}' in primaryTopics (strict): ${candidates.length} -> ${kept.length}`
    );
  }
  if (droppedByFloor > 0) {
    appliedFilters.push(`dropped ${droppedByFloor} below overlap floor ${overlapFloor}`);
  }
  if (kept.length === 0 && candidates.length > 0) {
    appliedFilters.push("no candidate clearly matched: honest empty result");
  }
  return { kept, appliedFilters };
}
