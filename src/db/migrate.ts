// Minimal migration runner: applies db/migrations/*.sql in order, tracking
// applied files in schema_migrations. Runs at boot when DATABASE_URL is set.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";

export async function migrate(pool: Pool): Promise<void> {
  await pool.query(
    `create table if not exists schema_migrations (
       name text primary key,
       applied_at timestamptz not null default now()
     )`
  );
  const { rows } = await pool.query(`select name from schema_migrations`);
  const applied = new Set((rows as Array<{ name: string }>).map((r) => r.name));
  // src/db/migrate.ts -> <root>/db/migrations ; dist/db/migrate.js -> <root>/db/migrations
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "db", "migrations");
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(dir, file), "utf8");
    await pool.query("begin");
    try {
      await pool.query(sql);
      await pool.query(`insert into schema_migrations (name) values ($1)`, [file]);
      await pool.query("commit");
      console.log(`migration applied: ${file}`);
    } catch (err) {
      await pool.query("rollback");
      throw err;
    }
  }
}
