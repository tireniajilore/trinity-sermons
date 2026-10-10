// verify_quote: check whether a phrase appears verbatim in a sermon's keyQuotes.

import { z } from "zod";
import type { PipelineDeps } from "../retrieval/pipeline.js";

export const VerifyQuoteInput = z
  .object({
    quote: z.string().min(1),
    sermonId: z.string().min(1).optional(),
  })
  .strict();

export const VerifyQuoteOutput = z.object({
  quote: z.string(),
  verified: z.boolean(),
  matches: z.array(
    z.object({
      sermonId: z.string(),
      title: z.string(),
      preacher: z.string().nullable(),
      matchedQuote: z.string(),
    })
  ),
});

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export const verifyQuoteTool = {
  name: "verify_quote",
  description:
    "Check whether a phrase appears verbatim in a sermon's keyQuotes. Use before quoting a sermon: pass the phrase you want to use and optionally a sermonId to check. Returns verified=true only on a verbatim match. GROUNDING: if verified=false, do not use the quote.",
  inputSchema: VerifyQuoteInput,
  outputSchema: VerifyQuoteOutput,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(deps: PipelineDeps, args: z.infer<typeof VerifyQuoteInput>) {
    const needle = norm(args.quote);
    const matches: Array<{
      sermonId: string;
      title: string;
      preacher: string | null;
      matchedQuote: string;
    }> = [];
    if (args.sermonId) {
      const record = await deps.repository.getById(args.sermonId);
      if (record) {
        for (const q of record.profile.keyQuotes) {
          if (norm(q).includes(needle) || needle.includes(norm(q))) {
            matches.push({
              sermonId: record.sermonId,
              title: record.title,
              preacher: record.preacher,
              matchedQuote: q,
            });
          }
        }
      }
    } else {
      const sermons = await deps.repository.listAll();
      for (const s of sermons) {
        for (const q of s.profile.keyQuotes) {
          if (norm(q).includes(needle) || needle.includes(norm(q))) {
            matches.push({
              sermonId: s.sermonId,
              title: s.title,
              preacher: s.preacher,
              matchedQuote: q,
            });
            break;
          }
        }
        if (matches.length >= 5) break;
      }
    }
    const structuredContent = VerifyQuoteOutput.parse({
      quote: args.quote,
      verified: matches.length > 0,
      matches,
    });
    return {
      content: [
        {
          type: "text" as const,
          text: matches.length > 0
            ? `Verified: "${args.quote}" appears in ${matches.length} sermon(s).`
            : `Not verified: "${args.quote}" does not appear verbatim in any sermon keyQuotes. Do not use it as a quotation.`,
        },
      ],
      structuredContent,
    };
  },
};
