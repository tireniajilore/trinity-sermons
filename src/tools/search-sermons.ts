// search_sermons: which complete Trinity message is most likely to help
// this person? Searches what each whole sermon is about — never isolated
// quotations or passing mentions.

import { z } from "zod";
import { runSearch, type PipelineDeps, type SearchPayload } from "../retrieval/pipeline.js";

export const SearchSermonsInput = z
  .object({
    query: z
      .string()
      .trim()
      .min(3, "query must be at least 3 characters")
      .max(500, "query must be at most 500 characters"),
    limit: z.number().int().min(1).max(8).default(5),
  })
  .strict();

export const SermonResultItem = z.object({
  sermonId: z.string(),
  title: z.string(),
  publishedAt: z.string(),
  blurb: z.string(),
  primaryTopics: z.array(z.string()),
  youtubeUrl: z.string(),
});

export const SearchSermonsOutput = z.object({
  query: z.string(),
  interpretedIntent: z.object({
    requiredSubject: z.string().nullable(),
    supportiveNeeds: z.array(z.string()),
  }),
  resultCount: z.number().int(),
  results: z.array(SermonResultItem),
  suggestedQueries: z.array(z.string()),
});

function textSummary(payload: SearchPayload): string {
  if (payload.results.length === 0) {
    const sugg =
      payload.suggestedQueries.length > 0
        ? ` Try: ${payload.suggestedQueries.map((s) => `"${s}"`).join(", ")}.`
        : "";
    return `No Trinity sermon clearly matched "${payload.query}".${sugg}`;
  }
  const lines = payload.results.map(
    (r, i) => `${i + 1}. ${r.title} (${r.publishedAt})\n   ${r.blurb}\n   ${r.youtubeUrl}`
  );
  return `Top Trinity sermons for "${payload.query}":\n${lines.join("\n")}`;
}

export const searchSermonsTool = {
  name: "search_sermons",
  description:
    "Find complete Trinity New York sermons about a topic or life situation (e.g. 'anxiety about my marriage'). Returns whole-message matches with a short blurb and a YouTube link that starts at the beginning. Empty results mean nothing clearly matched — that is better than a weak match.",
  inputSchema: SearchSermonsInput,
  outputSchema: SearchSermonsOutput,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(deps: PipelineDeps, args: z.infer<typeof SearchSermonsInput>) {
    const payload = await runSearch(deps, args.query, args.limit);
    const structuredContent = SearchSermonsOutput.parse(payload);
    return {
      content: [{ type: "text" as const, text: textSummary(payload) }],
      structuredContent,
    };
  },
};
