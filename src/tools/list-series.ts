// list_series: browse Trinity sermon series, most recent first.

import { z } from "zod";
import type { PipelineDeps } from "../retrieval/pipeline.js";

export const ListSeriesInput = z
  .object({ limit: z.number().int().min(1).max(50).default(20) })
  .strict();

export const ListSeriesOutput = z.object({
  series: z.array(
    z.object({
      name: z.string(),
      sermonCount: z.number(),
      firstPreached: z.string(),
      lastPreached: z.string(),
      preachers: z.array(z.string()),
    })
  ),
});

export const listSeriesTool = {
  name: "list_series",
  description:
    "List Trinity New York sermon series (e.g. Ten Commandments), most recently preached first. Use when someone asks what series Trinity is in or has taught. GROUNDING: cite only the series names, counts, and dates returned.",
  inputSchema: ListSeriesInput,
  outputSchema: ListSeriesOutput,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(deps: PipelineDeps, args: z.infer<typeof ListSeriesInput>) {
    const series = await deps.repository.listSeries(args.limit);
    const structuredContent = ListSeriesOutput.parse({ series });
    const lines = series.map(
      (s) =>
        `- ${s.name} (${s.sermonCount} sermons, ${s.firstPreached} to ${s.lastPreached})`
    );
    return {
      content: [
        {
          type: "text" as const,
          text:
            lines.length === 0
              ? "No sermon series are available."
              : `Trinity sermon series:\n${lines.join("\n")}`,
        },
      ],
      structuredContent,
    };
  },
};
