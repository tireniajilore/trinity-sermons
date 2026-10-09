-- 0002: sermon metadata for the agent-facing detail fields.
-- preacher/duration/series are factual (YouTube), captured at ingestion.

alter table videos
  add column if not exists preacher text null,
  add column if not exists duration_seconds integer null,
  add column if not exists series text null;
