// Evidence tokens: prove that get_sermon was called for a sermonId.
// Used by cite_sermons to gate citation generation on verified retrieval.

import { createHmac, randomBytes } from "crypto";

// Server secret — generated once per process. Tokens are valid for the
// lifetime of the server process (cleared on deploy, which is fine:
// the agent just re-verifies).
const SECRET = randomBytes(32);

export function issueEvidenceToken(sermonId: string): string {
  const h = createHmac("sha256", SECRET);
  h.update(sermonId);
  return `ev_${h.digest("hex").slice(0, 32)}`;
}

export function verifyEvidenceToken(sermonId: string, token: string): boolean {
  if (!token.startsWith("ev_")) return false;
  const expected = issueEvidenceToken(sermonId);
  // Constant-time comparison to avoid timing attacks
  if (token.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < token.length; i++) {
    diff |= token.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}
