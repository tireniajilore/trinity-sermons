// LLM relevance judge: gpt-4o-mini reads the query and each candidate sermon,
// keeps only the ones substantially about the query topic. This is the
// precision mechanism the deterministic filters could not provide — it
// judges meaning ("is this sermon ABOUT forgiveness?") not word overlap.
//
// Single batched call per search: ~30 candidates × ~150 tokens each.
// Fail-open: if the LLM call fails, the deterministic filter results pass
// through unchanged.

import type { Candidate } from "./candidates.js";

export const LLM_RERANK_MODEL = "gpt-4o-mini";
export const LLM_RERANK_PROMPT_VERSION = "judge-v3";

export interface RerankVerdict {
  sermonId: string;
  /** 0=irrelevant, 1=passing mention, 2=clearly helpful, 3=ideal match */
  score: number;
  keep: boolean;
  reason: string;
}

function apiKey(): string | null {
  return process.env.OPENAI_API_KEY ?? null;
}

function candidateSummary(c: Candidate): string {
  const s = c.sermon;
  return [
    `ID: ${s.sermonId}`,
    `Title: ${s.title}`,
    `Primary topics: ${s.profile.primaryTopics.join(", ")}`,
    `Thesis: ${s.profile.thesis}`,
    `Summary: ${s.profile.shortBlurb}`,
  ].join("\n");
}

const SYSTEM_PROMPT = `You are judging sermon search results for relevance. A user asked a question; below are candidate sermons retrieved by keyword and vector search.

For each candidate, score its relevance:

- 3 = Ideal: the sermon is substantially about the user's topic; a listener asking this question would feel this is exactly what they needed.
- 2 = Clearly helpful: the topic gets meaningful treatment (a substantial section, not just a mention), even if it's not the sermon's primary focus.
- 1 = Passing mention: the topic comes up briefly (an illustration, an aside, one point among many). Not enough to satisfy the question on its own.
- 0 = Irrelevant: about something else entirely, or matched on a coincidental word.

Be honest about 1 vs 2: a single story illustrating the topic is a 1; a five-minute teaching block on it is a 2.

Respond with JSON only: {"verdicts": [{"sermonId": "...", "score": 0-3, "reason": "one short sentence"}]}`;

export async function llmRerank(
  query: string,
  candidates: Candidate[],
  keepThreshold: number = 2
): Promise<Map<string, RerankVerdict> | null> {
  const key = apiKey();
  if (!key || candidates.length === 0) return null;

  const userContent = [
    `User query: ${query}`,
    "",
    "Candidates:",
    ...candidates.map((c, i) => `\n--- Candidate ${i + 1} ---\n${candidateSummary(c)}`),
  ].join("\n");

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: LLM_RERANK_MODEL,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userContent },
        ],
        response_format: { type: "json_object" },
        temperature: 0,
        max_tokens: 4000,
      }),
    });
    if (!res.ok) {
      console.error(`llmRerank: OpenAI ${res.status}`);
      return null;
    }
    const json = (await res.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    const content = json.choices?.[0]?.message?.content;
    if (!content) return null;
    const parsed = JSON.parse(content) as {
      verdicts: Array<{ sermonId: string; score: number; reason: string }>;
    };
    const map = new Map<string, RerankVerdict>();
    for (const v of parsed.verdicts ?? []) {
      if (typeof v.sermonId === "string" && typeof v.score === "number") {
        const score = Math.max(0, Math.min(3, Math.round(v.score)));
        map.set(v.sermonId, {
          sermonId: v.sermonId,
          score,
          // Keep threshold is configurable; default keeps 2+ ("clearly helpful").
          keep: score >= (keepThreshold ?? 2),
          reason: typeof v.reason === "string" ? v.reason : "",
        });
      }
    }
    return map;
  } catch (err) {
    console.error("llmRerank failed:", err);
    return null;
  }
}
