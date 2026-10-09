#!/usr/bin/env tsx
// Structured sermon-profile generation (OpenAI) + embedding with atomic
// publication.
//
// For each searchable video with a transcript: skip when content_hash +
// schema/prompt/model versions are unchanged. Otherwise generate the
// profile, validate it, render the labelled retrieval document, embed it,
// then upsert ALL profile fields atomically. On generation failure the
// previous valid row stays searchable; on first-time failure nothing is
// published. The corpus generation counter bumps once per run with at least
// one successful publication (then redeploy the app to clear its
// in-memory search cache).
//
// Requires: DATABASE_URL, OPENAI_API_KEY.
//
// Usage: npm run build-profiles [-- --limit 25]

import { Pool } from "pg";
import {
  generateProfile,
  renderRetrievalText,
  OpenAIEmbedder,
  profileInputHash,
  OPENAI_EMBEDDING_MODEL,
  OPENAI_PROFILE_MODEL,
  PROFILE_SCHEMA_VERSION,
  PROFILE_PROMPT_VERSION,
} from "../src/providers/openai.js";

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL || !process.env.OPENAI_API_KEY) {
    console.error("DATABASE_URL and OPENAI_API_KEY are required.");
    process.exit(1);
  }
  const limitIdx = process.argv.indexOf("--limit");
  const limit = limitIdx >= 0 ? Number(process.argv[limitIdx + 1]) || 25 : 25;
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  const { rows } = await pool.query(
    `select v.id, v.title, t.plain_text, t.content_hash, p.input_hash
     from videos v
     join sermon_transcripts t on t.video_id = v.id
     left join sermon_profiles p on p.video_id = v.id
     where v.is_searchable and v.suppressed_at is null
     order by v.published_at desc
     limit $1`,
    [limit]
  );

  const embedder = new OpenAIEmbedder();
  let published = 0;
  for (const row of rows as Array<{
    id: string; title: string; plain_text: string; content_hash: string; input_hash: string | null;
  }>) {
    const want = profileInputHash(row.content_hash);
    if (row.input_hash === want) {
      console.log(`skip (unchanged): ${row.id}`);
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
         values ($1, $2, $3, $4::vector, $5, $6, $7, $8, $9)
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
      published += 1;
      console.log(`published: ${row.id} (${row.title.slice(0, 60)})`);
    } catch (err) {
      console.error(`failed: ${row.id}: ${String((err as Error)?.message ?? err).slice(0, 200)}`);
    }
  }

  if (published > 0) {
    await pool.query(`update corpus_state set generation = generation + 1, updated_at = now() where id = 1`);
    console.log(`corpus generation bumped (${published} published) — redeploy the app to clear its search cache`);
  } else {
    console.log("nothing published");
  }
  await pool.end();
}

void main();
