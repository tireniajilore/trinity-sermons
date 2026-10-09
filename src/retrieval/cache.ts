// Versioned search cache. Key = sha256(normalized query + limit +
// pipeline version + corpus generation); successful payloads cached 15 min.
// Provider errors are never cached. The corpus generation counter increments
// only after a successful profile publication, so stale results become
// unreachable without a table-wide delete.

import { createHash } from "node:crypto";

const TTL_MS = 15 * 60 * 1000;

export interface CacheEntry<T> {
  payload: T;
  storedAt: number;
}

export class SearchCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();

  key(parts: { query: string; limit: number; matchMode: string; pipelineVersion: string; corpusGeneration: number }): string {
    return createHash("sha256")
      .update(`${parts.query}\n${parts.limit}\n${parts.matchMode}\n${parts.pipelineVersion}\n${parts.corpusGeneration}`)
      .digest("hex");
  }

  get(key: string): T | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (Date.now() - entry.storedAt > TTL_MS) {
      this.entries.delete(key);
      return null;
    }
    return entry.payload;
  }

  set(key: string, payload: T): void {
    if (this.entries.size > 1000) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    this.entries.set(key, { payload, storedAt: Date.now() });
  }
}
