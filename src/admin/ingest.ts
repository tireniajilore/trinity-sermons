// Token-protected admin ingestion. The sandbox running the YouTube crawl
// cannot reach Railway's private Postgres network, so captions are fetched
// offsite and POSTed here in batches; this module upserts them and runs the
// OpenAI profile backfill in the background (the service already has
// DATABASE_URL and OPENAI_API_KEY).
//
// POST /admin/ingest        { videos: IngestVideo[] } -> { accepted, upserted }
// GET  /admin/ingest-status -> { running, pending, done, failed, corpusGeneration, ... }
//
// Auth: Authorization: Bearer <INGEST_ADMIN_TOKEN>. If the token is not
// configured the routes behave as 404 (no surface advertised).

import { createHash, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "pg";
import {
  generateProfile,
  renderRetrievalText,
  OpenAIEmbedder,
  profileInputHash,
  OPENAI_EMBEDDING_MODEL,
  OPENAI_PROFILE_MODEL,
  PROFILE_SCHEMA_VERSION,
  PROFILE_PROMPT_VERSION,
} from "../providers/openai.js";

export interface IngestVideo {
  youtubeVideoId: string;
  title: string;
  publishedAt: string; // YYYY-MM-DD
  preacher: string | null;
  durationSeconds: number | null;
  series: string | null;
  source: "youtube_manual" | "youtube_auto";
  segments: Array<{ start: number; end: number; text: string }>;
  plainText: string;
}

export interface JobStatus {
  running: boolean;
  pending: number;
  done: number;
  failed: number;
  corpusGeneration: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  lastError: string | null;
}

const job: JobStatus = {
  running: false,
  pending: 0,
  done: 0,
  failed: 0,
  corpusGeneration: null,
  startedAt: null,
  finishedAt: null,
  lastError: null,
};

export function ingestToken(): string | null {
  return process.env.INGEST_ADMIN_TOKEN || null;
}

export function authorized(authHeader: string | undefined): boolean {
  const token = ingestToken();
  if (!token) return false;
  if (!authHeader || !authHeader.startsWith("Bearer ")) return false;
  const presented = Buffer.from(authHeader.slice(7));
  const expected = Buffer.from(token);
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

function contentHash(plainText: string): string {
  return createHash("sha256").update(plainText, "utf8").digest("hex");
}

export async function upsertBatch(
  pool: Pool,
  videos: IngestVideo[]
): Promise<{ videosUpserted: number; transcriptsUpserted: number }> {
  let videosUpserted = 0;
  let transcriptsUpserted = 0;
  for (const v of videos) {
    if (!v.youtubeVideoId || !v.title || !v.publishedAt || !v.plainText) continue;
    const hash = contentHash(v.plainText);
    const url = `https://www.youtube.com/watch?v=${v.youtubeVideoId}`;
    await pool.query(
      `insert into videos
         (id, youtube_video_id, title, published_at, youtube_url, preacher, duration_seconds, series, is_searchable, updated_at)
       values ($1,$2,$3,$4::date,$5,$6,$7,$8,true,now())
       on conflict (id) do update set
         title = excluded.title,
         published_at = excluded.published_at,
         youtube_url = excluded.youtube_url,
         preacher = excluded.preacher,
         duration_seconds = excluded.duration_seconds,
         series = excluded.series,
         updated_at = now()`,
      [v.youtubeVideoId, v.youtubeVideoId, v.title, v.publishedAt, url, v.preacher ?? null, v.durationSeconds ?? null, v.series ?? null]
    );
    videosUpserted += 1;
    await pool.query(
      `insert into sermon_transcripts
         (video_id, source, language, segments, plain_text, content_hash, fetched_at)
       values ($1,$2,'en',$3,$4,$5,now())
       on conflict (video_id) do update set
         source = excluded.source,
         segments = excluded.segments,
         plain_text = excluded.plain_text,
         content_hash = excluded.content_hash,
         fetched_at = now()`,
      [v.youtubeVideoId, v.source, JSON.stringify(v.segments), v.plainText, hash]
    );
    transcriptsUpserted += 1;
  }
  return { videosUpserted, transcriptsUpserted };
}

async function backfillLoop(pool: Pool): Promise<void> {
  const embedder = new OpenAIEmbedder();
  const { rows } = await pool.query(
    `select v.id, v.title, t.plain_text, t.content_hash, p.input_hash
     from videos v
     join sermon_transcripts t on t.video_id = v.id
     left join sermon_profiles p on p.video_id = v.id
     where v.is_searchable and v.suppressed_at is null
     order by v.published_at desc`
  );
  job.pending = rows.length;
  for (const row of rows as Array<{
    id: string; title: string; plain_text: string; content_hash: string; input_hash: string | null;
  }>) {
    const want = profileInputHash(row.content_hash);
    if (row.input_hash === want) {
      job.pending -= 1;
      continue;
    }
    try {
      const profile = await generateProfile(row.plain_text);
      const retrievalText = renderRetrievalText(row.title, profile);
      const embedding = await embedder.embed(retrievalText);
      if (!embedding) throw new Error("embedding returned null");
      await pool.query(
        `insert into sermon_profiles
           (video_id, profile, retrieval_text, embedding, input_hash,
            profile_schema_version, profile_prompt_version, profile_model, embedding_model)
         values ($1,$2,$3,$4::vector,$5,$6,$7,$8,$9)
         on conflict (video_id) do update set
           profile = excluded.profile,
           retrieval_text = excluded.retrieval_text,
           embedding = excluded.embedding,
           input_hash = excluded.input_hash,
           profile_schema_version = excluded.profile_schema_version,
           profile_prompt_version = excluded.profile_prompt_version,
           profile_model = excluded.profile_model,
           embedding_model = excluded.embedding_model,
           indexed_at = now()`,
        [
          row.id,
          JSON.stringify(profile),
          retrievalText,
          JSON.stringify(embedding),
          want,
          PROFILE_SCHEMA_VERSION,
          PROFILE_PROMPT_VERSION,
          OPENAI_PROFILE_MODEL,
          OPENAI_EMBEDDING_MODEL,
        ]
      );
      job.done += 1;
    } catch (err) {
      job.failed += 1;
      job.lastError = `${row.id}: ${String((err as Error)?.message ?? err).slice(0, 200)}`;
    }
    job.pending -= 1;
  }
  if (job.done > 0) {
    await pool.query(`update corpus_state set generation = generation + 1, updated_at = now() where id = 1`);
  }
  const { rows: g } = await pool.query(`select generation from corpus_state where id = 1`);
  job.corpusGeneration = g[0]?.generation ?? null;
}

export function startBackfill(pool: Pool): boolean {
  if (job.running) return false;
  job.running = true;
  job.done = 0;
  job.failed = 0;
  job.pending = 0;
  job.startedAt = new Date().toISOString();
  job.finishedAt = null;
  job.lastError = null;
  void backfillLoop(pool)
    .catch((err) => {
      job.lastError = String((err as Error)?.message ?? err).slice(0, 200);
    })
    .finally(() => {
      job.running = false;
      job.finishedAt = new Date().toISOString();
    });
  return true;
}

export async function getStatus(pool: Pool): Promise<JobStatus> {
  try {
    const { rows } = await pool.query(`select generation from corpus_state where id = 1`);
    job.corpusGeneration = rows[0]?.generation ?? job.corpusGeneration;
  } catch {
    // leave the last known value
  }
  return { ...job };
}

// ---------------------------------------------------------------------------
// Server-side YouTube fetching. Runs yt-dlp inside the Railway network
// (different egress IP from the sandbox) to fetch metadata + captions per
// video id, then upserts via upsertBatch. POST /admin/fetch-youtube
// { videoIds: string[] } kicks it off; progress is visible in the status.
// ---------------------------------------------------------------------------

const fetchJob = {
  running: false,
  total: 0,
  fetched: 0,
  noCaptions: 0,
  failed: 0,
  lastError: null as string | null,
  startedAt: null as string | null,
  finishedAt: null as string | null,
};

export function getFetchStatus() {
  return { ...fetchJob };
}

function tsToSec(t: string): number {
  const parts = t.trim().split(":").map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] || 0;
}

function parseVtt(text: string): Array<{ start: number; end: number; text: string }> {
  const segs: Array<{ start: number; end: number; text: string }> = [];
  const cueRe = /(\d+:)?\d+:\d+\.\d+\s*-->\s*(\d+:)?\d+:\d+\.\d+/;
  let start = 0;
  let end = 0;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line === "WEBVTT") continue;
    const m = line.match(cueRe);
    if (m) {
      const [a, b] = line.split("-->");
      start = tsToSec(a);
      end = tsToSec(b);
      continue;
    }
    if (line.startsWith("NOTE") || line.includes("-->")) continue;
    const clean = line
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .trim();
    if (clean) segs.push({ start, end, text: clean });
  }
  const out: typeof segs = [];
  for (const s of segs) {
    if (out.length === 0 || out[out.length - 1].text !== s.text) out.push(s);
  }
  return out;
}

const NAME_RE = /^(Pastor |Dr\. )?([A-Z][a-z'.]+)( & | and )?([A-Z][a-z'.]+)?( [A-Z][a-z'.]+)?$/;
function preacherFromTitle(title: string): string | null {
  const tail = title.split("|").pop()?.trim() ?? "";
  if (/^trinity new york/i.test(tail)) return null;
  return NAME_RE.test(tail) ? tail : null;
}

function runYtDlp(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const p = spawn("yt-dlp", args, { timeout: 180_000 });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("error", (e) => resolve({ stdout, stderr: stderr + String(e), code: 1 }));
    p.on("close", (code) => resolve({ stdout, stderr, code: code ?? 1 }));
  });
}

async function fetchOneVideo(
  pool: Pool,
  workdir: string,
  videoId: string
): Promise<"ok" | "no-captions" | "failed"> {
  const meta = await runYtDlp([
    "--skip-download",
    "--extractor-args",
    "youtube:player_client=android",
    "--print",
    "%(upload_date)s|%(duration)s|%(title)s",
    `https://www.youtube.com/watch?v=${videoId}`,
  ]);
  const line = meta.stdout.trim().split("\n").pop() ?? "";
  const [uploadDate, durStr, ...titleParts] = line.split("|");
  const title = titleParts.join("|").trim();
  if (!/^\d{8}$/.test(uploadDate || "") || !title) return "failed";
  if (uploadDate < "20230101") return "no-captions"; // out of scope, skip quietly
  const durationSeconds = Math.round(Number(durStr) || 0);
  if (durationSeconds < 300) return "no-captions"; // shorts/clips, not sermons

  // Manual subs first, then auto.
  let vttPath: string | null = null;
  let source: "youtube_manual" | "youtube_auto" | null = null;
  for (const [flag, suffix, src] of [
    ["--write-subs", "", "youtube_manual"],
    ["--write-auto-subs", ".auto", "youtube_auto"],
  ] as const) {
    const r = await runYtDlp([
      "--skip-download",
      "--extractor-args",
      "youtube:player_client=android",
      flag,
      "--sub-langs",
      "en.*",
      "--sub-format",
      "vtt/best",
      "--retries",
      "2",
      "-o",
      join(workdir, `%(id)s${suffix}.%(ext)s`),
      `https://www.youtube.com/watch?v=${videoId}`,
    ]);
    void r;
    const candidate = join(workdir, `${videoId}${suffix}.en.vtt`);
    try {
      await fs.access(candidate);
      vttPath = candidate;
      source = src;
      break;
    } catch {
      // try next
    }
  }
  if (!vttPath || !source) return "no-captions";

  const vtt = await fs.readFile(vttPath, "utf8");
  const segments = parseVtt(vtt);
  const plainText = segments.map((s) => s.text).join(" ");
  if (plainText.length < 500) return "no-captions";
  await fs.unlink(vttPath).catch(() => undefined);

  await upsertBatch(pool, [
    {
      youtubeVideoId: videoId,
      title,
      publishedAt: `${uploadDate.slice(0, 4)}-${uploadDate.slice(4, 6)}-${uploadDate.slice(6, 8)}`,
      preacher: preacherFromTitle(title),
      durationSeconds,
      series: null,
      source,
      segments,
      plainText,
    },
  ]);
  return "ok";
}

async function fetchLoop(pool: Pool, ids: string[]): Promise<void> {
  const workdir = await fs.mkdtemp(join(tmpdir(), "subs-"));
  try {
    for (const id of ids) {
      try {
        const res = await fetchOneVideo(pool, workdir, id);
        if (res === "ok") fetchJob.fetched += 1;
        else if (res === "no-captions") fetchJob.noCaptions += 1;
        else fetchJob.failed += 1;
      } catch (err) {
        fetchJob.failed += 1;
        fetchJob.lastError = `${id}: ${String((err as Error)?.message ?? err).slice(0, 160)}`;
      }
      // Gentle pacing against YouTube rate limits.
      await new Promise((r) => setTimeout(r, 4000));
    }
  } finally {
    await fs.rm(workdir, { recursive: true, force: true });
  }
}

export function startFetch(pool: Pool, ids: string[]): boolean {
  if (fetchJob.running) return false;
  fetchJob.running = true;
  fetchJob.total = ids.length;
  fetchJob.fetched = 0;
  fetchJob.noCaptions = 0;
  fetchJob.failed = 0;
  fetchJob.lastError = null;
  fetchJob.startedAt = new Date().toISOString();
  fetchJob.finishedAt = null;
  void fetchLoop(pool, ids)
    .catch((err) => {
      fetchJob.lastError = String((err as Error)?.message ?? err).slice(0, 200);
    })
    .finally(() => {
      fetchJob.running = false;
      fetchJob.finishedAt = new Date().toISOString();
      // Chain the profile backfill once fetching is done.
      startBackfill(pool);
    });
  return true;
}
