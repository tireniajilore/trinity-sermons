// list_series_sermons: sermons in a series, in preaching order.

import { z } from "zod";
import type { PipelineDeps } from "../retrieval/pipeline.js";
import { youtubeUrl } from "../sermons/types.js";
import { SermonResultItem, formatCitation } from "./search-sermons.js";

export const ListSeriesSermonsInput = z
  .object({
    series: z.string().min(1),
    limit: z.number().int().min(1).max(50).default(20),
  })
  .strict();

export const ListSeriesSermonsOutput = z.object({
  series: z.string().nullable(),
  sermonCount: z.number(),
  sermons: z.array(SermonResultItem),
  suggestedSeries: z.array(z.string()).optional(),
});

export const listSeriesSermonsTool = {
  name: "list_series_sermons",
  description:
    "Get the sermons in a Trinity series (e.g. 'Ten Commandments'), oldest first. Use after list_series, or when someone wants to follow a whole teaching series in order. GROUNDING: cite only the sermons returned, in the order returned.",
  inputSchema: ListSeriesSermonsInput,
  outputSchema: ListSeriesSermonsOutput,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(deps: PipelineDeps, args: z.infer<typeof ListSeriesSermonsInput>) {
    const sermons = await deps.repository.listSeriesSermons(args.series, args.limit);
    const toItem = (s: (typeof sermons)[number]) => {
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
    };
    if (sermons.length === 0) {
      const suggestedSeries = await deps.repository.suggestSeries(args.series, 5);
      const structuredContent = ListSeriesSermonsOutput.parse({
        series: null,
        sermonCount: 0,
        sermons: [],
        suggestedSeries,
      });
      return {
        content: [
          {
            type: "text" as const,
            text:
              `No series found matching "${args.series}".` +
              (suggestedSeries.length > 0
                ? ` Did you mean: ${suggestedSeries.join(", ")}?`
                : ""),
          },
        ],
        structuredContent,
      };
    }
    const seriesName = sermons[0].series ?? args.series;
    const structuredContent = ListSeriesSermonsOutput.parse({
      series: seriesName,
      sermonCount: sermons.length,
      sermons: sermons.map(toItem),
    });
    const lines = sermons.map((s, i) => `${i + 1}. ${s.title} (${s.publishedAt})`);
    return {
      content: [
        {
          type: "text" as const,
          text: `Sermons in "${seriesName}":\n${lines.join("\n")}`,
        },
      ],
      structuredContent,
    };
  },
};
