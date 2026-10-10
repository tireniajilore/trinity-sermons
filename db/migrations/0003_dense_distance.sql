-- 0003: expose dense cosine distance in hybrid search for filter calibration.
--
-- The filter needs a genuinely discriminative relevance signal. Lexical
-- overlap can't separate good from bad candidates (proven by human eval:
-- identical overlap distributions across grades 0-3). Dense cosine distance
-- can. This returns it alongside the fused score so the application-layer
-- whole-sermon filter can threshold on meaning, not just words.

-- Postgres cannot change a function's return type via CREATE OR REPLACE.
drop function if exists hybrid_search_sermon_profiles(vector, text, integer, integer, integer, integer, double precision, double precision);

create function hybrid_search_sermon_profiles(
  query_embedding vector(1536),
  query_text text,
  dense_limit integer default 50,
  lexical_limit integer default 50,
  result_limit integer default 30,
  rrf_k integer default 60,
  dense_weight double precision default 0.65,
  lexical_weight double precision default 0.35
)
returns table (video_id text, fused_score double precision, dense_distance double precision)
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
  select f.video_id,
         f.fused_score,
         (select p.embedding <=> query_embedding
          from sermon_profiles p
          where p.video_id = f.video_id) as dense_distance
  from fused f
  order by f.fused_score desc
  limit result_limit;
$$;
