// find_similar_sermons: sermons like this one, by embedding similarity.

import { z } from "zod";
import type { PipelineDeps } from "../retrieval/pipeline.js";
import { youtubeUrl } from "../sermons/types.js";
import { SermonResultItem, formatCitation } from "./search-sermons.js";

export const FindSimilarInput = z
  .object({
    sermonId: z.string().min(1),
    limit: z.number().int().min(1).max(8).default(5),
  })
  .strict();

export const FindSimilarOutput = z.object({
  sourceSermon: z.object({ sermonId: z.string(), title: z.string() }).nullable(),
  sermons: z.array(SermonResultItem),
});

export const findSimilarTool = {
  name: "find_similar_sermons",
  description:
    "Find Trinity sermons similar to a given one (by sermonId from search_sermons, get_sermon, or list_recent_sermons). Use when someone liked a sermon and wants more like it. GROUNDING: cite only the sermons returned. Never invent similar titles.",
  inputSchema: FindSimilarInput,
  outputSchema: FindSimilarOutput,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(deps: PipelineDeps, args: z.infer<typeof FindSimilarInput>) {
    const source = await deps.repository.getById(args.sermonId);
    if (!source) {
      const structuredContent = FindSimilarOutput.parse({
        sourceSermon: null,
        sermons: [],
      });
      return {
        content: [
          {
            type: "text" as const,
            text: `SERMON_NOT_FOUND: no sermon with id "${args.sermonId}". Use search_sermons or list_recent_sermons to find a valid sermonId.`,
          },
        ],
        structuredContent,
      };
    }
    const sermons = await deps.repository.findSimilar(args.sermonId, args.limit);
    const structuredContent = FindSimilarOutput.parse({
      sourceSermon: { sermonId: source.sermonId, title: source.title },
      sermons: sermons.map((s) => {
        const url = youtubeUrl(s.youtubeVideoId);
        return {
          sermonId: s.sermonId,
          title: s.title,
          publishedAt: s.publishedAt,
          blurb: s.profile.shortBlurb,
          primaryTopics: s.profile.primaryTopics,
          youtubeUrl: url,
          thesis: s.profile.thesis,
          preacher: s.preacher,
          durationSeconds: s.durationSeconds,
          citation: formatCitation(s.title, s.preacher, s.publishedAt, url),
          quotable: false as const,
        };
      }),
    });
    const lines = sermons.map((s, i) => `${i + 1}. ${s.title} (${s.publishedAt})`);
    return {
      content: [
        {
          type: "text" as const,
          text:
            lines.length === 0
              ? `No similar sermons found for "${source.title}".`
              : `Sermons similar to "${source.title}":\n${lines.join("\n")}`,
        },
      ],
      structuredContent,
    };
  },
};
