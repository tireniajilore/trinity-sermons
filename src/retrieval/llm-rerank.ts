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
export const LLM_RERANK_PROMPT_VERSION = "judge-v1";

export interface RerankVerdict {
  sermonId: string;
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

For each candidate, decide: KEEP or DROP.

KEEP only if the sermon is substantially ABOUT the user's topic — the topic is a primary focus of the sermon, something the preacher spends meaningful time on.

DROP if:
- The topic is only mentioned in passing (a single illustration, a brief aside, one bullet in a list of many).
- The sermon is about something else entirely and matched on a coincidental word.
- You cannot tell from the summary that the topic is a real focus.

Be strict. It is better to return an empty list than to keep weak matches. If none of the candidates are truly about the topic, keep none.

Respond with JSON only: {"verdicts": [{"sermonId": "...", "keep": true/false, "reason": "one short sentence"}]}`;

export async function llmRerank(
  query: string,
  candidates: Candidate[]
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
      verdicts: Array<{ sermonId: string; keep: boolean; reason: string }>;
    };
    const map = new Map<string, RerankVerdict>();
    for (const v of parsed.verdicts ?? []) {
      if (typeof v.sermonId === "string" && typeof v.keep === "boolean") {
        map.set(v.sermonId, {
          sermonId: v.sermonId,
          keep: v.keep,
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
