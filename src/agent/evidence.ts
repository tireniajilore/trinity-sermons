import { createHash } from "node:crypto";
import type { Pool } from "pg";

export interface Transcript { text: string; source: string; version: string }
export interface TranscriptStore { get(sermonId: string): Promise<Transcript | null> }
export class PostgresTranscriptStore implements TranscriptStore {
  constructor(private readonly pool: Pool) {}
  async get(id: string): Promise<Transcript | null> {
    const { rows } = await this.pool.query(
      `select t.plain_text, t.source, t.content_hash from sermon_transcripts t
       join videos v on v.id = t.video_id
       where t.video_id = $1 and v.is_searchable and v.suppressed_at is null`, [id]);
    return rows[0] ? { text: rows[0].plain_text, source: rows[0].source, version: rows[0].content_hash } : null;
  }
}

export interface Passage {
  id: string; sermonId: string; version: string; source: string;
  start: number; end: number; text: string;
}

// Exact source slices, with overlap to retain local context. No generated quotes.
export function passages(sermonId: string, transcript: Transcript): Passage[] {
  const out: Passage[] = [];
  for (let start = 0; start < transcript.text.length; start += 800) {
    const end = Math.min(start + 1200, transcript.text.length);
    out.push({ id: createHash("sha256").update(`${sermonId}:${transcript.version}:${start}:${end}`).digest("hex"),
      sermonId, version: transcript.version, source: transcript.source,
      start, end, text: transcript.text.slice(start, end) });
    if (end === transcript.text.length) break;
  }
  return out;
}

// Case and whitespace only: preserve words and punctuation, including negation.
export function normalizedQuote(value: string): string {
  return value.normalize("NFC").replace(/\s+/g, " ").trim().toLocaleLowerCase("en");
}
export function containsQuote(text: string, quote: string): boolean {
  const needle = normalizedQuote(quote);
  return needle.length >= 10 && normalizedQuote(text).includes(needle);
}

export function selectPassages(items: Passage[], query: string, limit = 12): Passage[] {
  const words = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])];
  const score = (p: Passage) => words.filter(w => p.text.toLowerCase().includes(w)).length;
  return [...items].sort((a, b) => score(b) - score(a) || a.start - b.start).slice(0, limit);
}
