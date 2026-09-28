#!/usr/bin/env node
/**
 * Adopt the migration baseline on an EXISTING database that was created with
 * `drizzle-kit push` (e.g. the Replit development DB), without touching data.
 *
 * It never runs the baseline DDL against the target. Instead it:
 *   1. refuses if the target already has migration history;
 *   2. applies all migrations to an EMPTY scratch database
 *      (BASELINE_VERIFY_DATABASE_URL) and fingerprints both schemas
 *      (enums, columns, constraints, indexes in schema "public");
 *   3. prints any difference and exits non-zero if they differ;
 *   4. only with --commit, and only if identical, records 0000_baseline as
 *      applied in drizzle.__drizzle_migrations (hash + created_at exactly as
 *      drizzle's migrator computes them). Later migrations then apply normally.
 *
 * Usage:
 *   DATABASE_URL=<target> BASELINE_VERIFY_DATABASE_URL=<empty scratch db> \
 *     node lib/db/scripts/baseline-existing-db.mjs            # verify only
 *   ... node lib/db/scripts/baseline-existing-db.mjs --commit # verify + record
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(here, "../migrations");
const commit = process.argv.includes("--commit");

const targetUrl = process.env.DATABASE_URL;
const verifyUrl = process.env.BASELINE_VERIFY_DATABASE_URL;
if (!targetUrl) fail("DATABASE_URL (the existing database to baseline) is required.");
if (!verifyUrl) fail("BASELINE_VERIFY_DATABASE_URL (an EMPTY scratch database) is required for verification.");
if (verifyUrl === targetUrl) fail("BASELINE_VERIFY_DATABASE_URL must be a different, empty database.");

function fail(message) {
  console.error(`baseline: ${message}`);
  process.exit(1);
}

const journal = JSON.parse(fs.readFileSync(path.join(migrationsFolder, "meta/_journal.json"), "utf8"));
const baselineEntry = journal.entries[0];
if (!baselineEntry || !baselineEntry.tag.endsWith("_baseline")) fail("First journal entry is not the baseline migration.");
const baselineSql = fs.readFileSync(path.join(migrationsFolder, `${baselineEntry.tag}.sql`), "utf8");
const baselineHash = crypto.createHash("sha256").update(baselineSql).digest("hex");

async function fingerprint(client) {
  const queries = {
    enum: `SELECT t.typname AS k, string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) AS v
             FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
             JOIN pg_namespace n ON n.oid = t.typnamespace
            WHERE n.nspname = 'public' GROUP BY t.typname`,
    column: `SELECT table_name || '.' || column_name AS k,
                    concat_ws('|', data_type, udt_name, is_nullable, column_default, character_maximum_length) AS v
               FROM information_schema.columns WHERE table_schema = 'public'`,
    constraint: `SELECT c.conrelid::regclass::text || '.' || c.conname AS k, pg_get_constraintdef(c.oid) AS v
                   FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
                  WHERE n.nspname = 'public'`,
    index: `SELECT tablename || '.' || indexname AS k, indexdef AS v FROM pg_indexes WHERE schemaname = 'public'`,
  };
  const out = new Map();
  for (const [kind, sql] of Object.entries(queries)) {
    const { rows } = await client.query(sql);
    for (const row of rows) out.set(`${kind}:${row.k}`, row.v ?? "");
  }
  return out;
}

async function hasMigrationHistory(client) {
  const { rows } = await client.query(`SELECT to_regclass('drizzle.__drizzle_migrations') AS t`);
  if (!rows[0].t) return false;
  const { rows: count } = await client.query(`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`);
  return count[0].n > 0;
}

const target = new pg.Client({ connectionString: targetUrl });
const verify = new pg.Client({ connectionString: verifyUrl });
await target.connect();
await verify.connect();
try {
  if (await hasMigrationHistory(target)) {
    console.log("baseline: target already has migration history; nothing to do. Use `pnpm --filter @workspace/db run migrate`.");
    process.exit(0);
  }
  const { rows: publicTables } = await target.query(
    `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'`);
  if (publicTables[0].n === 0) {
    fail("target has no tables. A fresh database does not need baselining: run `pnpm --filter @workspace/db run migrate`.");
  }
  const { rows: verifyTables } = await verify.query(
    `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'`);
  if (verifyTables[0].n !== 0 || await hasMigrationHistory(verify)) {
    fail("BASELINE_VERIFY_DATABASE_URL must point at an EMPTY database.");
  }

  await migrate(drizzle(verify), { migrationsFolder });
  const expected = await fingerprint(verify);
  const actual = await fingerprint(target);

  const differences = [];
  for (const [key, value] of expected) {
    if (!actual.has(key)) differences.push(`missing in target   ${key} = ${value}`);
    else if (actual.get(key) !== value) differences.push(`differs in target   ${key}\n    expected: ${value}\n    actual:   ${actual.get(key)}`);
  }
  for (const [key, value] of actual) {
    if (!expected.has(key)) differences.push(`extra in target     ${key} = ${value}`);
  }

  if (differences.length) {
    console.error(`baseline: target schema does NOT match ${baselineEntry.tag} (${differences.length} difference(s)):`);
    for (const line of differences.sort()) console.error(`  ${line}`);
    console.error("baseline: nothing was recorded. Reconcile the target first (see lib/db/MIGRATIONS.md).");
    process.exit(2);
  }

  console.log(`baseline: target schema matches ${baselineEntry.tag} exactly (${expected.size} objects compared).`);
  if (!commit) {
    console.log("baseline: dry run only. Re-run with --commit to record the baseline as applied.");
    process.exit(0);
  }
  await target.query("BEGIN");
  await target.query(`CREATE SCHEMA IF NOT EXISTS drizzle`);
  await target.query(`CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
    id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)`);
  await target.query(`INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)`,
    [baselineHash, baselineEntry.when]);
  await target.query("COMMIT");
  console.log(`baseline: recorded ${baselineEntry.tag} as applied (hash ${baselineHash.slice(0, 12)}…, created_at ${baselineEntry.when}). No data or DDL was changed.`);
} finally {
  await target.end().catch(() => {});
  await verify.end().catch(() => {});
}
