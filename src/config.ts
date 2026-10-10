// Versioned retrieval configuration. The relevance threshold lives here —
// a file under review — never in an undocumented environment variable.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface RetrievalConfig {
  pipelineVersion: string;
  overlapFloor: number;
  /** Max cosine distance (0=identical, 2=opposite) for dense keep. Null disables. */
  denseMaxDistance: number | null;
  /** LLM relevance judge (gpt-4o-mini). When enabled, it has the final say. */
  llmRerank: { enabled: boolean };
  matchModeDefault: "strict" | "broad";
  fusion: { k: number; denseWeight: number; lexicalWeight: number };
  candidateCounts: { dense: number; lexical: number; fused: number };
  corpusGeneration: number;
}

let cached: RetrievalConfig | null = null;

export function loadRetrievalConfig(): RetrievalConfig {
  if (cached) return cached;
  const dir = dirname(fileURLToPath(import.meta.url));
  // src/config.ts -> <root>/config/retrieval.json ; dist/config.js -> <root>/config/retrieval.json
  const path = join(dir, "..", "config", "retrieval.json");
  const raw = JSON.parse(readFileSync(path, "utf8")) as RetrievalConfig;
  if (
    typeof raw.pipelineVersion !== "string" ||
    typeof raw.overlapFloor !== "number" ||
    raw.overlapFloor < 0 ||
    raw.overlapFloor > 1
  ) {
    throw new Error("config/retrieval.json is invalid");
  }
  cached = raw;
  return raw;
}
