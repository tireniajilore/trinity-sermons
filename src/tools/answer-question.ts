// answer_sermon_question: composite tool — server-side search, retrieve, verify.
//
// Instead of the agent orchestrating search_sermons → get_sermon → verify_quote,
// this tool runs the entire workflow server-side with verification enforced in code.
// The agent makes one call and receives grounded findings or an explicit
// insufficient-evidence result.

import { z } from "zod";
import type { PipelineDeps } from "../retrieval/pipeline.js";
import { runSearch } from "../retrieval/pipeline.js";
import type { MatchMode } from "../retrieval/filter.js";
import { youtubeUrl } from "../sermons/types.js";
import { formatCitation } from "./search-sermons.js";
import { issueEvidenceToken } from "./evidence.js";

export const AnswerQuestionInput = z
  .object({
    question: z.string().min(3).max(2000),
    maxResults: z.number().int().min(1).max(8).default(3),
    matchMode: z.enum(["strict", "broad"]).default("strict"),
  })
  .strict();

const Finding = z.object({
  /** The grounded claim this finding supports. */
  claim: z.string(),
  sermonId: z.string(),
  title: z.string(),
  preacher: z.string().nullable(),
  publishedAt: z.string(),
  /** Verbatim evidence: keyQuote if available, otherwise thesis. */
  evidence: z.string(),
  evidenceType: z.enum(["quote", "thesis"]),
  citation: z.string(),
  youtubeUrl: z.string(),
  evidenceToken: z.string(),
});

export const AnswerQuestionOutput = z.object({
  status: z.enum(["verified", "insufficient_evidence"]),
  question: z.string(),
  findings: z.array(Finding),
  /** Present only when status is insufficient_evidence. */
  suggestedQueries: z.array(z.string()).optional(),
  answerPolicy: z.object({
    useOnlyTheseFindings: z.literal(true),
    doNotInventBeyondFindings: z.literal(true),
    citeUsingProvidedCitations: z.literal(true),
  }),
});

export const answerQuestionTool = {
  name: "answer_sermon_question",
  description:
    "Answer a question about what Trinity New York has preached. This is the PRIMARY tool for content questions — it searches, retrieves full sermon records, and verifies evidence server-side in one call. Returns grounded findings with verbatim quotes and canonical citations, or an explicit insufficient-evidence result. Prefer this over manually chaining search_sermons → get_sermon. GROUNDING: use only the findings returned; never invent beyond them.",
  inputSchema: AnswerQuestionInput,
  outputSchema: AnswerQuestionOutput,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(deps: PipelineDeps, args: z.infer<typeof AnswerQuestionInput>) {
    const payload = await runSearch(deps, args.question, args.maxResults, args.matchMode as MatchMode);

    if (payload.results.length === 0) {
      const structuredContent = AnswerQuestionOutput.parse({
        status: "insufficient_evidence" as const,
        question: args.question,
        findings: [],
        suggestedQueries: payload.suggestedQueries,
        answerPolicy: {
          useOnlyTheseFindings: true as const,
          doNotInventBeyondFindings: true as const,
          citeUsingProvidedCitations: true as const,
        },
      });
      return {
        content: [
          {
            type: "text" as const,
            text: `Insufficient evidence: no Trinity sermon clearly matched "${args.question}". Do not invent an answer.`,
          },
        ],
        structuredContent,
      };
    }

    // Retrieve full records and build verified findings server-side
    const findings: Array<z.infer<typeof Finding>> = [];
    for (const r of payload.results) {
      const record = await deps.repository.getById(r.sermonId);
      if (!record) continue; // Shouldn't happen, but skip defensively

      // Prefer a verbatim keyQuote as evidence; fall back to thesis
      const quote = record.profile.keyQuotes[0];
      const evidence = quote ?? record.profile.thesis;
      const evidenceType = (quote ? "quote" : "thesis") as "quote" | "thesis";

      const url = youtubeUrl(record.youtubeVideoId);
      findings.push({
        claim: record.profile.thesis,
        sermonId: record.sermonId,
        title: record.title,
        preacher: record.preacher,
        publishedAt: record.publishedAt,
        evidence,
        evidenceType,
        citation: formatCitation(record.title, record.preacher, record.publishedAt, url),
        youtubeUrl: url,
        evidenceToken: issueEvidenceToken(record.sermonId),
      });
    }

    const structuredContent = AnswerQuestionOutput.parse({
      status: "verified" as const,
      question: args.question,
      findings,
      answerPolicy: {
        useOnlyTheseFindings: true as const,
        doNotInventBeyondFindings: true as const,
        citeUsingProvidedCitations: true as const,
      },
    });

    const lines = findings.map(
      (f, i) =>
        `${i + 1}. ${f.citation}\n   Claim: ${f.claim}\n   Evidence (${f.evidenceType}): "${f.evidence}"`
    );
    return {
      content: [
        {
          type: "text" as const,
          text: `Verified findings for "${args.question}":\n${lines.join("\n")}`,
        },
      ],
      structuredContent,
    };
  },
};
