// search_sermons: which complete Trinity message is most likely to help
// this person? Searches what each whole sermon is about — never isolated
// quotations or passing mentions. Designed for agents: the server retrieves
// broadly and filters transparently; the agent judges from the results.

import { z } from "zod";
import { runSearch, type PipelineDeps, type SearchPayload } from "../retrieval/pipeline.js";
import type { MatchMode } from "../retrieval/filter.js";

export const SearchSermonsInput = z
  .object({
    query: z
      .string()
      .trim()
      .min(3, "query must be at least 3 characters")
      .max(2000, "query must be at most 2000 characters"),
    limit: z.number().int().min(1).max(8).default(5),
    matchMode: z.enum(["strict", "broad"]).default("strict"),
  })
  .strict();

export function formatCitation(
  title: string,
  preacher: string | null,
  publishedAt: string,
  youtubeUrl: string
): string {
  const who = preacher ? ` by ${preacher}` : "";
  return `"${title}"${who} (${publishedAt}) — ${youtubeUrl}`;
}

export const DiscoveryItem = z.object({
  sermonId: z.string(),
  title: z.string(),
  /** AI-generated summary — NOT a verbatim quote. Do not attribute these words to the preacher. */
  blurb: z.string(),
  primaryTopics: z.array(z.string()),
  /** AI-generated summary of the sermon's message — NOT a verbatim quote. */
  thesis: z.string(),
  /** Discovery only — not verified for citation. */
  verificationStatus: z.literal("NOT_VERIFIED"),
  /** Call this tool with sermonId to get verified date, preacher, URL, citation, and keyQuotes. */
  nextAction: z.literal("get_sermon"),
});

// Full verified record — only from get_sermon.
export const SermonResultItem = z.object({
  sermonId: z.string(),
  title: z.string(),
  blurb: z.string(),
  primaryTopics: z.array(z.string()),
  thesis: z.string(),
  publishedAt: z.string(),
  youtubeUrl: z.string(),
  preacher: z.string().nullable(),
  durationSeconds: z.number().nullable(),
  /** Pre-formatted citation — copy verbatim instead of constructing your own. */
  citation: z.string(),
  /** Verified. Safe to cite. */
  verificationStatus: z.literal("VERIFIED"),
  quotable: z.literal(false),
});

export const AnswerPolicy = z.object({
  useOnlyReturnedSources: z.literal(true),
  doNotInventQuotes: z.literal(true),
  sayWhenNotFound: z.literal(true),
  citeVerbatimFrom: z.literal("keyQuotes via get_sermon"),
  distinguishInterpretation: z.literal(true),
});

export const SearchSermonsOutput = z.object({
  query: z.string(),
  interpretedIntent: z.object({
    requiredSubject: z.string().nullable(),
    supportiveNeeds: z.array(z.string()),
  }),
  appliedFilters: z.array(z.string()),
  resultCount: z.number().int(),
  results: z.array(DiscoveryItem),
  suggestedQueries: z.array(z.string()),
  answerPolicy: AnswerPolicy,
});

function textSummary(payload: SearchPayload): string {
  const lines = payload.results.map((r, i) => {
    return `${i + 1}. ${r.title} [${r.sermonId}]\n   ${r.blurb}\n   → Call get_sermon with sermonId "${r.sermonId}" for verified date, preacher, URL, and quotes.`;
  });
  const sugg =
    payload.suggestedQueries.length > 0
      ? `\nAlso try: ${payload.suggestedQueries.map((s) => `"${s}"`).join(", ")}.`
      : "";
  const filters =
    payload.appliedFilters.length > 0 ? `\n[${payload.appliedFilters.join("; ")}]` : "";
  if (payload.results.length === 0) {
    return `No Trinity sermon clearly matched "${payload.query}".${sugg}${filters}`;
  }
  return `Top Trinity sermons for "${payload.query}":\n${lines.join("\n")}${sugg}${filters}`;
}

export const searchSermonsTool = {
  name: "search_sermons",
  description:
    "DISCOVERY: Find complete Trinity New York sermons about a topic or life situation. Write a rich query — paste the situation verbatim (up to 2000 chars). Returns whole-message matches with AI-generated blurbs and theses (marked quotable=false — do NOT quote these as the preacher's words). For verbatim quotes, call get_sermon for keyQuotes. Check appliedFilters to see how the query was interpreted, and use matchMode 'broad' if 'strict' returns too little. Empty results mean nothing clearly matched. GROUNDING: cite only sermons, titles, preachers, and theses from the returned results. Use the pre-formatted citation field verbatim. Never invent quotes. Distinguish what the sermons say from your own interpretation. If results are empty, say so plainly.",
  inputSchema: SearchSermonsInput,
  outputSchema: SearchSermonsOutput,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(deps: PipelineDeps, args: z.infer<typeof SearchSermonsInput>) {
    const payload = await runSearch(deps, args.query, args.limit, args.matchMode as MatchMode);
    const structuredContent = SearchSermonsOutput.parse(payload);
    return {
      content: [{ type: "text" as const, text: textSummary(payload) }],
      structuredContent,
    };
  },
};
