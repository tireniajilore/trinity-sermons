// Postgres providers: sermon reads and hybrid candidate retrieval against
// the hybrid_search_sermon_profiles RPC. Wired when DATABASE_URL is set;
// otherwise the pipeline uses the in-memory providers (dev/tests).
//
// Query embedding is injectable: NullEmbedder until the Gemini adapter
// lands, at which point the RPC gets real dense vectors. A null embedding
// takes the lexical-only path (spec: embedding failure -> lexical, then
// Cohere).

import { Pool } from "pg";
import type { SermonRepository, SeriesInfo } from "../sermons/repository.js";
import type { Candidate, CandidateProvider } from "../retrieval/candidates.js";
import type { InterpretedIntent } from "../retrieval/intent.js";
import type { SermonProfile, SermonRecord } from "../sermons/types.js";

export interface QueryEmbedder {
  embed(text: string): Promise<number[] | null>;
}

export class NullEmbedder implements QueryEmbedder {
  async embed(_text: string): Promise<number[] | null> {
    return null;
  }
}

export function createDbPool(): Pool | null {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  return new Pool({ connectionString: url, max: 5 });
}

interface ProfileRow {
  id: string;
  youtube_video_id: string;
  title: string;
  published_at: string;
  preacher: string | null;
  duration_seconds: number | null;
  series: string | null;
  profile: SermonProfile;
  retrieval_text: string;
}

function toRecord(row: ProfileRow): SermonRecord {
  return {
    sermonId: row.id,
    youtubeVideoId: row.youtube_video_id,
    title: row.title,
    publishedAt: row.published_at,
    preacher: row.preacher,
    durationSeconds: row.duration_seconds,
    series: row.series,
    profile: row.profile,
    retrievalText: row.retrieval_text,
  };
}

const PROFILE_SELECT = `
  select v.id, v.youtube_video_id, v.title,
         v.published_at::text as published_at,
         v.preacher, v.duration_seconds, v.series,
         p.profile, p.retrieval_text
  from videos v
  join sermon_profiles p on p.video_id = v.id
  where v.is_searchable and v.suppressed_at is null
`;

export class PostgresSermonRepository implements SermonRepository {
  constructor(private readonly pool: Pool) {}

  async getById(sermonId: string): Promise<SermonRecord | null> {
    const { rows } = await this.pool.query(`${PROFILE_SELECT} and v.id = $1`, [sermonId]);
    return rows.length === 0 ? null : toRecord(rows[0] as ProfileRow);
  }

  async listRecent(limit: number): Promise<SermonRecord[]> {
    const { rows } = await this.pool.query(
      `${PROFILE_SELECT} order by v.published_at desc limit $1`,
      [limit]
    );
    return (rows as ProfileRow[]).map(toRecord);
  }

  async listAll(): Promise<SermonRecord[]> {
    const { rows } = await this.pool.query(`${PROFILE_SELECT} order by v.published_at desc`);
    return (rows as ProfileRow[]).map(toRecord);
  }

  async listSeries(limit: number): Promise<SeriesInfo[]> {
    const { rows } = await this.pool.query(
      `select v.series as name,
              count(*)::int as sermon_count,
              min(v.published_at)::text as first_preached,
              max(v.published_at)::text as last_preached,
              array_agg(distinct v.preacher) filter (where v.preacher is not null) as preachers
       from videos v
       join sermon_profiles p on p.video_id = v.id
       where v.is_searchable and v.suppressed_at is null and v.series is not null
       group by v.series
       order by max(v.published_at) desc
       limit $1`,
      [limit]
    );
    return (rows as Array<{ name: string; sermon_count: number; first_preached: string; last_preached: string; preachers: string[] }>).map((r) => ({
      name: r.name,
      sermonCount: r.sermon_count,
      firstPreached: r.first_preached,
      lastPreached: r.last_preached,
      preachers: r.preachers ?? [],
    }));
  }

  async listSeriesSermons(series: string, limit: number): Promise<SermonRecord[]> {
    // Exact (case-insensitive) first.
    let { rows } = await this.pool.query(
      `${PROFILE_SELECT} and v.series ilike $1 order by v.published_at asc limit $2`,
      [series, limit]
    );
    if (rows.length === 0) {
      // Substring fallback: find the best-matching series name, then list it.
      const { rows: nameRows } = await this.pool.query(
        `select v.series as name
         from videos v
         where v.is_searchable and v.suppressed_at is null and v.series is not null
           and v.series ilike '%' || $1 || '%'
         group by v.series
         order by count(*) desc
         limit 1`,
        [series]
      );
      if (nameRows.length > 0) {
        const best = nameRows[0].name as string;
        ({ rows } = await this.pool.query(
          `${PROFILE_SELECT} and v.series = $1 order by v.published_at asc limit $2`,
          [best, limit]
        ));
      }
    }
    return (rows as ProfileRow[]).map(toRecord);
  }

  async suggestSeries(series: string, limit: number): Promise<string[]> {
    // No pg_trgm: suggest most recent series names as a fallback.
    const { rows } = await this.pool.query(
      `select v.series as name
       from videos v
       where v.is_searchable and v.suppressed_at is null and v.series is not null
       group by v.series
       order by max(v.published_at) desc
       limit $1`,
      [limit]
    );
    return (rows as Array<{ name: string }>).map((r) => r.name);
  }

  async findSimilar(sermonId: string, limit: number): Promise<SermonRecord[]> {
    const { rows } = await this.pool.query(
      `${PROFILE_SELECT} and v.id != $1
       order by p.embedding <=> (select p2.embedding from sermon_profiles p2 where p2.video_id = $1)
       limit $2`,
      [sermonId, limit]
    );
    return (rows as ProfileRow[]).map(toRecord);
  }
}

export class PostgresCandidateProvider implements CandidateProvider {
  constructor(
    private readonly pool: Pool,
    private readonly embedder: QueryEmbedder = new NullEmbedder()
  ) {}

  async candidates(
    intent: InterpretedIntent,
    _sermons: SermonRecord[],
    counts: { dense: number; lexical: number; fused: number },
    fusion: { k: number; denseWeight: number; lexicalWeight: number }
  ): Promise<Candidate[]> {
    const embedding = await this.embedder.embed(intent.retrievalQuery).catch(() => null);
    if (embedding) {
      const { rows } = await this.pool.query(
        `select video_id, fused_score, dense_distance
         from hybrid_search_sermon_profiles($1::vector, $2, $3, $4, $5, $6, $7, $8)`,
        [
          JSON.stringify(embedding),
          intent.retrievalQuery,
          counts.dense,
          counts.lexical,
          counts.fused,
          fusion.k,
          fusion.denseWeight,
          fusion.lexicalWeight,
        ]
      );
      return this.toCandidates(rows as Array<{ video_id: string; fused_score: number; dense_distance: number | null }>);
    }
    // Lexical-only fallback when no query embedding is available.
    const { rows } = await this.pool.query(
      `select p.video_id, 0::float8 as fused_score, null::float8 as dense_distance
       from sermon_profiles p
       join videos v on v.id = p.video_id
       where v.is_searchable and v.suppressed_at is null
         and p.retrieval_fts @@ plainto_tsquery('english', $1)
       order by ts_rank_cd(p.retrieval_fts, plainto_tsquery('english', $1)) desc
       limit $2`,
      [intent.retrievalQuery, counts.fused]
    );
    return this.toCandidates(rows as Array<{ video_id: string; fused_score: number; dense_distance: number | null }>);
  }

  private async toCandidates(
    rows: Array<{ video_id: string; fused_score: number; dense_distance: number | null }>
  ): Promise<Candidate[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.video_id);
    const { rows: profileRows } = await this.pool.query(
      `${PROFILE_SELECT} and v.id = any($1)`,
      [ids]
    );
    const byId = new Map((profileRows as ProfileRow[]).map((r) => [r.id, toRecord(r)]));
    return rows
      .map((r) => ({
        sermon: byId.get(r.video_id)!,
        fusedScore: Number(r.fused_score),
        denseDistance: r.dense_distance === null ? null : Number(r.dense_distance),
      }))
      .filter((c) => c.sermon !== undefined);
  }
}
