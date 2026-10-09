-- Trinity Sermons initial schema.
-- Requires the pgvector extension (Railway: use the pgvector/pgvector:pg16
-- image; Supabase: enable the vector extension in the dashboard).

create extension if not exists "pgcrypto";
create extension if not exists "vector";

-- Every known Trinity New York video.
create table videos (
  id                 text primary key,
  youtube_video_id   text unique not null,
  title              text not null,
  published_at       date not null,
  youtube_url        text not null,
  is_searchable      boolean not null default true,
  suppressed_at      timestamptz null,
  suppressed_reason  text null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index videos_published_at_idx on videos (published_at desc);

-- Canonical transcript per video (YouTube captions; never audio/STT).
create table sermon_transcripts (
  video_id     text primary key references videos (id) on delete cascade,
  source       text not null check (source in ('youtube_manual', 'youtube_auto')),
  language     text not null default 'en',
  segments     jsonb not null,
  plain_text   text not null,
  content_hash text not null,
  fetched_at   timestamptz not null default now()
);

-- One active profile row per sermon. The indexer computes the complete
-- profile + embedding first, then a single upsert atomically replaces every
-- field; a failed generation leaves the previous valid row searchable.
create table sermon_profiles (
  video_id               text primary key references videos (id) on delete cascade,
  profile                jsonb not null,
  retrieval_text         text not null,
  retrieval_fts          tsvector generated always as (to_tsvector('english', retrieval_text)) stored,
  embedding              vector(1536) not null,
  input_hash             text not null,
  profile_schema_version integer not null,
  profile_prompt_version text not null,
  profile_model          text not null,
  embedding_model        text not null,
  indexed_at             timestamptz not null default now()
);
create index sermon_profiles_fts_idx on sermon_profiles using gin (retrieval_fts);
create index sermon_profiles_embedding_idx on sermon_profiles
  using hnsw (embedding vector_cosine_ops);
create index sermon_profiles_indexed_at_idx on sermon_profiles (indexed_at);
create index sermon_profiles_model_idx on sermon_profiles
  (profile_model, profile_prompt_version, embedding_model);

-- Corpus generation: increments only after a successful profile publication.
-- Search cache keys include it, so stale results become unreachable without
-- a table-wide cache delete.
create table corpus_state (
  id          integer primary key check (id = 1),
  generation  bigint not null default 1,
  updated_at  timestamptz not null default now()
);
insert into corpus_state (id, generation) values (1, 1);

-- Aggregate-only search telemetry. Raw query text is retained 30 days for
-- retrieval evaluation, then deleted; aggregate counts are preserved.
-- Never store client IPs or MCP conversation content here.
create table search_events (
  id                 uuid primary key default gen_random_uuid(),
  query_text         text not null,
  normalized_query   text not null,
  interpreted_intent jsonb not null,
  candidate_video_ids text[] not null,
  result_video_ids   text[] not null,
  rerank_scores      double precision[] not null,
  pipeline_version   text not null,
  latency_ms         integer not null,
  created_at         timestamptz not null default now()
);
create index search_events_created_at_idx on search_events (created_at);

-- Versioned search-result cache (15-minute TTL enforced by readers).
create table search_cache (
  cache_key     text primary key,
  payload       jsonb not null,
  stored_at     timestamptz not null default now()
);
create index search_cache_stored_at_idx on search_cache (stored_at);

-- Hybrid candidate retrieval: dense top-N + lexical top-N fused with
-- weighted reciprocal-rank fusion, deduplicated, best-M kept.
-- Recall-optimised: no relevance threshold is applied here.
create or replace function hybrid_search_sermon_profiles(
  query_embedding vector(1536),
  query_text text,
  dense_limit integer default 50,
  lexical_limit integer default 50,
  result_limit integer default 30,
  rrf_k integer default 60,
  dense_weight double precision default 0.65,
  lexical_weight double precision default 0.35
)
returns table (video_id text, fused_score double precision)
language sql stable as $$
  with dense_ranked as (
    select p.video_id, row_number() over (order by p.embedding <=> query_embedding) as rnk
    from sermon_profiles p
    join videos v on v.id = p.video_id
    where v.is_searchable and v.suppressed_at is null
    order by p.embedding <=> query_embedding
    limit dense_limit
  ),
  lexical_ranked as (
    select p.video_id, row_number() over (order by ts_rank_cd(p.retrieval_fts, plainto_tsquery('english', query_text)) desc) as rnk
    from sermon_profiles p
    join videos v on v.id = p.video_id
    where v.is_searchable and v.suppressed_at is null
      and p.retrieval_fts @@ plainto_tsquery('english', query_text)
    order by ts_rank_cd(p.retrieval_fts, plainto_tsquery('english', query_text)) desc
    limit lexical_limit
  ),
  fused as (
    select coalesce(d.video_id, l.video_id) as video_id,
           coalesce(dense_weight / (rrf_k + d.rnk), 0)
             + coalesce(lexical_weight / (rrf_k + l.rnk), 0) as fused_score
    from dense_ranked d
    full outer join lexical_ranked l on l.video_id = d.video_id
  )
  select f.video_id, f.fused_score
  from fused f
  order by f.fused_score desc
  limit result_limit;
$$;

-- Retention: delete raw query text older than 30 days (aggregate counts
-- survive in application-level rollups, not in this table).
create or replace function prune_search_events()
returns integer
language plpgsql as $$
declare
  deleted_count integer;
begin
  delete from search_events where created_at < now() - interval '30 days';
  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;
