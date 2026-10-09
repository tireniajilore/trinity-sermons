#!/usr/bin/env tsx
// Caption + metadata ingestion for @TrinityNewYork.
//
// Pipeline: channel RSS -> video metadata -> YouTube caption tracks ->
// canonical transcript stored in sermon_transcripts. Videos without captions
// are recorded as caption_missing and never indexed; audio is never
// downloaded and no speech-to-text is invoked.
//
// Requires: DATABASE_URL (Postgres with pgvector). No YouTube API key needed
// for the RSS listing; caption fetch uses the timedtext endpoints via yt-dlp.
//
// Usage: npm run ingest [-- --since 2023-01-01]

const CHANNEL_RSS = "https://www.youtube.com/feeds/videos.xml?channel_id=";
// TODO: resolve the @TrinityNewYork channel id (youtube.com/@TrinityNewYork)
// and set it here once confirmed via the channel page.

interface VideoMeta {
  youtubeVideoId: string;
  title: string;
  publishedAt: string;
  /** Factual metadata captured at ingestion (may be null when unknown). */
  preacher: string | null;
  durationSeconds: number | null;
  series: string | null;
}

async function listChannelVideos(since: string): Promise<VideoMeta[]> {
  // TODO: fetch the RSS feed (paginated via yt-dlp --flat-playlist as
  // fallback for >15 entries), filter publishedAt >= since. For each video:
  // duration via `yt-dlp --print duration`, preacher/series parsed from the
  // title/description ("Pastor Taylor Wilkerson", "... | Foundations").
  void since;
  throw new Error("not implemented: needs DATABASE_URL + channel id");
}

async function fetchCaptions(_videoId: string): Promise<{ source: "youtube_manual" | "youtube_auto"; segments: unknown[]; plainText: string } | null> {
  // TODO: yt-dlp --write-subs --write-auto-subs --sub-langs 'en.*' --skip-download
  // --sub-format vtt, parse to segments; return null when no captions exist.
  return null;
}

async function main(): Promise<void> {
  const since = process.argv.includes("--since")
    ? process.argv[process.argv.indexOf("--since") + 1]
    : "2023-01-01";
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set — refusing to run without a database.");
    process.exit(1);
  }
  const videos = await listChannelVideos(since);
  console.log(`found ${videos.length} videos since ${since}`);
  for (const v of videos) {
    const captions = await fetchCaptions(v.youtubeVideoId);
    if (!captions) {
      console.log(`caption_missing: ${v.youtubeVideoId} ${v.title}`);
      continue;
    }
    // TODO: upsert video metadata (title, published_at, preacher,
    // duration_seconds, series) into videos; validate, hash, and upsert
    // the transcript into sermon_transcripts; compare content_hash +
    // model versions to skip unchanged videos.
    void v;
  }
}

void main();
