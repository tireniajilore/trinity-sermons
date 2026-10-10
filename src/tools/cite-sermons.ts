// cite_sermons: generate canonical citations, gated on evidence tokens.
//
// The server will ONLY generate a citation for a sermonId if the caller
// provides a valid evidenceToken from get_sermon for that sermonId.
// This makes verification a dependency for server-side citation generation:
// the agent cannot get a canonical citation without first retrieving
// the verified evidence.

import { z } from "zod";
import type { PipelineDeps } from "../retrieval/pipeline.js";
import { youtubeUrl } from "../sermons/types.js";
import { formatCitation } from "./search-sermons.js";
import { verifyEvidenceToken } from "./evidence.js";

export const CiteSermonsInput = z
  .object({
    citations: z
      .array(
        z.object({
          sermonId: z.string().min(1),
          evidenceToken: z.string().min(1),
        })
      )
      .min(1)
      .max(20),
  })
  .strict();

export const CiteSermonsOutput = z.object({
  citations: z.array(
    z.object({
      sermonId: z.string(),
      citation: z.string(),
    })
  ),
  rejected: z.array(
    z.object({
      sermonId: z.string(),
      reason: z.string(),
    })
  ),
});

export const citeSermonsTool = {
  name: "cite_sermons",
  description:
    "Generate canonical citations for sermons you have verified. Requires the evidenceToken from get_sermon for each sermonId. The server REFUSES to generate citations without a valid token — call get_sermon first. GROUNDING: only use citations returned here; never construct your own.",
  inputSchema: CiteSermonsInput,
  outputSchema: CiteSermonsOutput,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(deps: PipelineDeps, args: z.infer<typeof CiteSermonsInput>) {
    const citations: Array<{ sermonId: string; citation: string }> = [];
    const rejected: Array<{ sermonId: string; reason: string }> = [];
    for (const { sermonId, evidenceToken } of args.citations) {
      if (!verifyEvidenceToken(sermonId, evidenceToken)) {
        rejected.push({
          sermonId,
          reason:
            "Invalid or missing evidence token. Call get_sermon for this sermonId first to obtain a valid token.",
        });
        continue;
      }
      const record = await deps.repository.getById(sermonId);
      if (!record) {
        rejected.push({ sermonId, reason: "Sermon not found." });
        continue;
      }
      citations.push({
        sermonId,
        citation: formatCitation(
          record.title,
          record.preacher,
          record.publishedAt,
          youtubeUrl(record.youtubeVideoId)
        ),
      });
    }
    const structuredContent = CiteSermonsOutput.parse({ citations, rejected });
    return {
      content: [
        {
          type: "text" as const,
          text:
            rejected.length === 0
              ? `${citations.length} citation(s) generated from verified evidence.`
              : `${citations.length} citation(s) generated, ${rejected.length} rejected (no valid evidence token).`,
        },
      ],
      structuredContent,
    };
  },
};
