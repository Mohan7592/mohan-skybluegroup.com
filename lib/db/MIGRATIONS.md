# Database migrations

The schema is defined in `lib/db/src/schema/*.ts`. Versioned SQL migrations live in `lib/db/migrations/`. **These migrations are the only supported way to change a shared database.**

Before this baseline, the project used `drizzle-kit push` only. It had no migration files or history. The application does no schema creation at runtime; there is no DDL in `artifacts/api-server`.

## Commands (run from the repo root)

| Command | Use |
|---|---|
| `pnpm --filter @workspace/db run generate -- --name <change>` | After editing `src/schema`, write the next `NNNN_<change>.sql`. Review and commit it. |
| `pnpm --filter @workspace/db run migrate` | Apply pending migrations to `DATABASE_URL`. It is idempotent, and it is what `scripts/post-merge.sh` runs. |
| `pnpm --filter @workspace/db run check` | Check that the migration files and snapshots are consistent. |
| `pnpm --filter @workspace/db run baseline:verify` | Adopting an existing DB, step 1: a dry-run comparison (see below). |
| `pnpm --filter @workspace/db run baseline:commit` | Adopting an existing DB, step 2: record the baseline as applied. |
| `pnpm --filter @workspace/db run push:scratch-only` | Throwaway local databases only. **Never run it on the Replit/shared DB.** |

`drizzle.config.ts` requires `DATABASE_URL` for every command, including `generate`.

## The baseline (`0000_baseline`)

- `0000_baseline.sql` is the complete schema exactly as it stood at Milestone 4 (commit `558d792`): 40 tables, 14 enums, and every constraint and index.
- It already holds the **post-migration** passenger enum `passenger_metric_mapping_status` = `MATCHED_VARIANT, ROUTE_LEVEL_ONLY, UNMATCHED, CONFLICT`.
- It also already includes the placeholder tables `mockups`, `decks` and `deck_slides` from Milestone 4.
- Future Mockup Studio tables and changes must be added as `0001_…` and later migrations. Never edit `0000_baseline.sql`: its SHA-256 is what gets recorded in `drizzle.__drizzle_migrations`.

### Fresh database (new clone, CI, a new environment)

Run this once:

```bash
DATABASE_URL=<empty db> pnpm --filter @workspace/db run migrate
```

The database starts empty. Inventory, routes and passenger data come from sync, import or a restore, never from migrations.

### Existing database created by `push` (the current Replit DB)

The Replit DB already holds the Milestone 4 schema and live data, but it has no migration history. Do **not** run `migrate` on it before it is baselined: `migrate` would try to re-create the existing objects. It fails and rolls back without changing anything, but post-merge stays blocked until the DB is baselined.

1. **Back up the database** (`pg_dump`) first.
2. Create an **empty scratch** database for verification, then run the dry run:

   ```bash
   DATABASE_URL=<replit db> BASELINE_VERIFY_DATABASE_URL=<empty scratch db> \
     pnpm --filter @workspace/db run baseline:verify
   ```

   The dry run applies the migrations to the scratch DB and compares the two schemas: enums, columns, types, defaults, nullability, constraints and indexes. It writes nothing to the Replit DB.
3. Check the result:
   - **If it reports `matches 0000_baseline exactly`**, recreate the scratch DB empty and run `baseline:commit`. This inserts a single row into `drizzle.__drizzle_migrations`, recording the baseline hash and timestamp. **No data or DDL is changed.** From then on, `migrate` applies only new migrations.
   - **If it reports differences, nothing is recorded.** The usual cause is a DB where the passenger status backfill was never run: the enum still shows `MATCHED/AMBIGUOUS`. In that case:
     - Review and run `artifacts/api-server/src/cli/migrate-passenger-metric-statuses.sql` once. It is atomic and fails closed unless the data matches the expected 14,594 rows.
     - Reconcile any other reported difference by hand.
     - Re-run `baseline:verify`.
     - Never force the baseline over a mismatched schema.

`migrate-passenger-metric-statuses.sql` is a one-time data backfill for that legacy DB. It is **not** part of the migration chain, and a fresh DB never needs it.

## Tested locally (Postgres 16)

1. A fresh DB migrates to all 40 tables, and a re-run is a no-op.
2. `generate` against the current schema reports "No schema changes", and `check` passes.
3. A DB created by `push` and containing data verifies as an exact match (730 objects compared). `baseline:commit` records the baseline, a later `migrate` is a no-op, and the data is intact.
4. A drifted DB (the legacy passenger enum) is refused, with the differences listed and nothing recorded.
5. `migrate` on a DB that has not been baselined exits 1 and leaves the schema unchanged.
6. A simulated `0001` migration applies cleanly to both a fresh DB and a baselined DB with data.
