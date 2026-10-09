// Query interpretation: two authority levels.
//
// 1. Deterministic facts from the user's actual words (explicit alias map).
//    An explicit subject word becomes the REQUIRED subject.
// 2. Advisory model inferences (supportive needs, retrieval rewrite) — used
//    to improve recall and ordering, never to create hard exclusions.
//    Until the Gemini adapter is wired, advisory inference is a no-op and the
//    original query plus deterministic aliases drive retrieval.

export interface InterpretedIntent {
  requiredSubject: string | null;
  supportiveNeeds: string[];
  retrievalQuery: string;
}

/** Canonical subject -> trigger words in explicit user language. */
export const ALIAS_MAP: Record<string, string[]> = {
  marriage: ["marriage", "married", "relationship", "relationships", "spouse", "husband", "wife", "dating"],
  grief: ["grief", "grieving", "loss", "heartbreak", "mourning", "sorrow"],
  anxiety: ["anxiety", "anxious", "fear", "worry", "stress", "overwhelmed"],
};

export function normalizeQuery(query: string): string {
  return query.trim().replace(/\s+/g, " ");
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9']+/)
    .filter(Boolean);
}

function matchedSubjects(tokens: string[]): string[] {
  const tokenSet = new Set(tokens);
  return Object.entries(ALIAS_MAP)
    .filter(([, triggers]) => triggers.some((t) => tokenSet.has(t)))
    .map(([subject]) => subject);
}

export interface AdvisoryIntent {
  supportiveNeeds: string[];
  retrievalQuery: string;
}

/** Placeholder for the Gemini advisory pass. Deterministic-only for now. */
export async function advisoryIntent(_query: string): Promise<AdvisoryIntent | null> {
  return null;
}

export async function interpretQuery(rawQuery: string): Promise<InterpretedIntent> {
  const query = normalizeQuery(rawQuery);
  const subjects = matchedSubjects(tokenize(query));
  const advisory = await advisoryIntent(query).catch(() => null);

  // Explicit user language decides the required subject: the first matched
  // canonical subject in alias-map order. Model inference can never promote
  // a supportive need into a hard requirement.
  const requiredSubject = subjects[0] ?? null;
  const supportiveNeeds = [
    ...subjects.slice(1),
    ...(advisory?.supportiveNeeds ?? []).filter((s) => !subjects.includes(s)),
  ];

  return {
    requiredSubject,
    supportiveNeeds,
    retrievalQuery: advisory?.retrievalQuery ?? query,
  };
}
