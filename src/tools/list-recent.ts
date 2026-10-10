// list_recent_sermons: what Trinity has preached recently, newest first.

import { z } from "zod";
import type { PipelineDeps } from "../retrieval/pipeline.js";
import { youtubeUrl } from "../sermons/types.js";
import { SermonResultItem, formatCitation } from "./search-sermons.js";

export const ListRecentInput = z
  .object({ limit: z.number().int().min(1).max(20).default(10) })
  .strict();

export const ListRecentOutput = z.object({ sermons: z.array(SermonResultItem) });

export const listRecentTool = {
  name: "list_recent_sermons",
  description:
    "List the most recently preached Trinity New York sermons, newest first. Use when someone asks what Trinity has preached lately without naming a topic. GROUNDING: cite only the titles, dates, and preachers returned. Never invent sermon details.",
  inputSchema: ListRecentInput,
  outputSchema: ListRecentOutput,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(deps: PipelineDeps, args: z.infer<typeof ListRecentInput>) {
    const sermons = await deps.repository.listRecent(args.limit);
    const structuredContent = ListRecentOutput.parse({
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
        };
      }),
    });
    const lines = structuredContent.sermons.map(
      (s, i) => `${i + 1}. ${s.title} (${s.publishedAt})\n   ${s.blurb}`
    );
    return {
      content: [
        {
          type: "text" as const,
          text:
            lines.length === 0
              ? "No recent sermons are available."
              : `Recent Trinity sermons:\n${lines.join("\n")}`,
        },
      ],
      structuredContent,
    };
  },
};
