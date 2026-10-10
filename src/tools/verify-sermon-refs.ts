// verify_sermon_references: check that sermon IDs exist and return canonical metadata.

import { z } from "zod";
import type { PipelineDeps } from "../retrieval/pipeline.js";
import { youtubeUrl } from "../sermons/types.js";

export const VerifyRefsInput = z
  .object({
    sermonIds: z.array(z.string()).min(1).max(20),
  })
  .strict();

export const VerifyRefsOutput = z.object({
  verified: z.array(
    z.object({
      sermonId: z.string(),
      title: z.string(),
      preacher: z.string().nullable(),
      publishedAt: z.string(),
      youtubeUrl: z.string(),
    })
  ),
  notFound: z.array(z.string()),
});

export const verifyRefsTool = {
  name: "verify_sermon_references",
  description:
    "Verify that sermon IDs from search results actually exist. Returns canonical title, preacher, date, and URL for each valid ID, and lists any IDs not found. Use before citing sermons in an answer. GROUNDING: only cite sermons in the verified list.",
  inputSchema: VerifyRefsInput,
  outputSchema: VerifyRefsOutput,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(deps: PipelineDeps, args: z.infer<typeof VerifyRefsInput>) {
    const verified: Array<{
      sermonId: string;
      title: string;
      preacher: string | null;
      publishedAt: string;
      youtubeUrl: string;
    }> = [];
    const notFound: string[] = [];
    for (const id of args.sermonIds) {
      const record = await deps.repository.getById(id);
      if (record) {
        verified.push({
          sermonId: record.sermonId,
          title: record.title,
          preacher: record.preacher,
          publishedAt: record.publishedAt,
          youtubeUrl: youtubeUrl(record.youtubeVideoId),
        });
      } else {
        notFound.push(id);
      }
    }
    const structuredContent = VerifyRefsOutput.parse({ verified, notFound });
    return {
      content: [
        {
          type: "text" as const,
          text:
            notFound.length === 0
              ? `All ${verified.length} sermon reference(s) verified.`
              : `${verified.length} verified, ${notFound.length} not found: ${notFound.join(", ")}. Do not cite the unverified IDs.`,
        },
      ],
      structuredContent,
    };
  },
};
