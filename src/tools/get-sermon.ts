// get_sermon: fuller information about one known sermon, after search.

import { z } from "zod";
import type { PipelineDeps } from "../retrieval/pipeline.js";
import { youtubeUrl } from "../sermons/types.js";

export const GetSermonInput = z.object({ sermonId: z.string().min(1) }).strict();

export const GetSermonOutput = z.object({
  sermon: z.object({
    sermonId: z.string(),
    title: z.string(),
    publishedAt: z.string(),
    youtubeUrl: z.string(),
    blurb: z.string(),
    thesis: z.string(),
    primaryTopics: z.array(z.string()),
    secondaryTopics: z.array(z.string()),
    audienceNeeds: z.array(z.string()),
    questionsAnswered: z.array(z.string()),
    desiredOutcomes: z.array(z.string()),
    framework: z.array(z.string()),
    scriptures: z.array(z.string()),
    preacher: z.string().nullable(),
    durationSeconds: z.number().nullable(),
    series: z.string().nullable(),
    keyQuotes: z.array(z.string()),
  }),
});

export const getSermonTool = {
  name: "get_sermon",
  description:
    "Get the full profile of one Trinity sermon by its sermonId (from search_sermons or list_recent_sermons): thesis, topics, audience needs, questions answered, teaching framework, and scriptures.",
  inputSchema: GetSermonInput,
  outputSchema: GetSermonOutput,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(deps: PipelineDeps, args: z.infer<typeof GetSermonInput>) {
    const record = await deps.repository.getById(args.sermonId);
    if (!record) {
      return {
        content: [
          {
            type: "text" as const,
            text: `SERMON_NOT_FOUND: no sermon with id "${args.sermonId}". Use search_sermons or list_recent_sermons to find a valid sermonId.`,
          },
        ],
        isError: true,
        _meta: { code: "SERMON_NOT_FOUND" },
      };
    }
    const structuredContent = GetSermonOutput.parse({
      sermon: {
        sermonId: record.sermonId,
        title: record.title,
        publishedAt: record.publishedAt,
        youtubeUrl: youtubeUrl(record.youtubeVideoId),
        blurb: record.profile.shortBlurb,
        thesis: record.profile.thesis,
        primaryTopics: record.profile.primaryTopics,
        secondaryTopics: record.profile.secondaryTopics,
        audienceNeeds: record.profile.audienceNeeds,
        questionsAnswered: record.profile.questionsAnswered,
        desiredOutcomes: record.profile.desiredOutcomes,
        framework: record.profile.framework,
        scriptures: record.profile.scriptures,
        preacher: record.preacher,
        durationSeconds: record.durationSeconds,
        series: record.series,
        keyQuotes: record.profile.keyQuotes,
      },
    });
    const quote = record.profile.keyQuotes[0]
      ? `\n"${record.profile.keyQuotes[0]}"`
      : "";
    return {
      content: [
        {
          type: "text" as const,
          text: `${record.title} (${record.publishedAt})${quote}\n${record.profile.shortBlurb}\n${youtubeUrl(record.youtubeVideoId)}`,
        },
      ],
      structuredContent,
    };
  },
};
