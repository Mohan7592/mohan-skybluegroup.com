-- Review-only, atomic backfill for the exact 14,594-row passenger dataset.
-- This transaction locks passenger imports and route definitions, preserves every
-- source/audit field and private-object reference, and rolls back completely on error.
-- It never reads, writes, moves, or deletes the private source objects themselves.
-- Main agent/operator: inspect this script before running:
-- psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f artifacts/api-server/src/cli/migrate-passenger-metric-statuses.sql
-- If any statement fails, PostgreSQL rolls back the whole transaction. Inspect
-- passenger_route_metrics and passenger_metric_mapping_status, fix the cause, then
-- rerun the complete script; there is no committed intermediate enum/backfill state.

\set ON_ERROR_STOP on

BEGIN;

LOCK TABLE passenger_metric_import_batches, passenger_route_metrics IN ACCESS EXCLUSIVE MODE;
LOCK TABLE bus_routes IN SHARE MODE;

DO $preflight$
DECLARE
  row_total bigint;
  matched_total bigint;
  ambiguous_total bigint;
  unmatched_total bigint;
  legacy_total bigint;
  unsupported_total bigint;
  conflict_groups bigint;
  conflict_rows bigint;
BEGIN
  SELECT
    count(*),
    count(*) FILTER (WHERE mapping_status::text = 'MATCHED'),
    count(*) FILTER (WHERE mapping_status::text = 'AMBIGUOUS'),
    count(*) FILTER (WHERE mapping_status::text = 'UNMATCHED'),
    count(*) FILTER (WHERE mapping_status::text IN ('MATCHED', 'AMBIGUOUS', 'UNMATCHED')),
    count(*) FILTER (WHERE mapping_status::text NOT IN (
      'MATCHED', 'AMBIGUOUS', 'UNMATCHED',
      'MATCHED_VARIANT', 'ROUTE_LEVEL_ONLY', 'CONFLICT'
    ))
  INTO row_total, matched_total, ambiguous_total, unmatched_total, legacy_total, unsupported_total
  FROM passenger_route_metrics;

  SELECT count(*), coalesce(sum(group_rows), 0)
  INTO conflict_groups, conflict_rows
  FROM (
    SELECT count(*) AS group_rows
    FROM passenger_route_metrics
    WHERE btrim(normalized_source_route_identifier) <> ''
    GROUP BY normalized_source_route_identifier, month
    HAVING count(DISTINCT passenger_count) > 1
  ) AS divergent_groups;

  IF row_total <> 14594 OR conflict_groups <> 38 OR conflict_rows <> 76 THEN
    RAISE EXCEPTION 'Passenger mapping preflight failed: expected exactly 14,594 rows and 38 non-empty divergent route/month groups (76 rows); found rows %, groups %, rows in groups %.',
      row_total, conflict_groups, conflict_rows;
  END IF;
  IF unsupported_total > 0 THEN
    RAISE EXCEPTION 'Passenger mapping preflight failed: found % unsupported status rows.', unsupported_total;
  END IF;
  IF legacy_total > 0 AND (
    matched_total <> 7326 OR ambiguous_total <> 5241 OR unmatched_total <> 2027
  ) THEN
    RAISE EXCEPTION 'Passenger mapping preflight failed: expected legacy statuses 7,326 MATCHED, 5,241 AMBIGUOUS, and 2,027 UNMATCHED; found %, %, %.',
      matched_total, ambiguous_total, unmatched_total;
  END IF;
END
$preflight$;

CREATE TEMP TABLE _passenger_metric_source_snapshot ON COMMIT DROP AS
SELECT
  id,
  import_batch_id,
  source_route_identifier,
  normalized_source_route_identifier,
  source_variant_identifier,
  route_candidates,
  source_values,
  source_file,
  source_row,
  month,
  passenger_count,
  trip_count,
  imported_at,
  mapping_method,
  mapping_note
FROM passenger_route_metrics;

CREATE TEMP TABLE _passenger_metric_batch_snapshot ON COMMIT DROP AS
SELECT id, source_file, source_object_path, source_sha256, source_row_count, imported_at
FROM passenger_metric_import_batches;

-- Only an exact canonical routeId match after NFKC/case/outer and repeated-space
-- normalization may become ROUTE_LEVEL_ONLY. Punctuation/compact near-matches fail.
CREATE TEMP TABLE _passenger_metric_route_family_map ON COMMIT DROP AS
SELECT
  metric.id AS metric_id,
  min(route.id::text)::uuid AS bus_route_id
FROM passenger_route_metrics AS metric
CROSS JOIN LATERAL jsonb_array_elements(
  CASE
    WHEN jsonb_typeof(metric.route_candidates) = 'array' THEN metric.route_candidates
    ELSE '[]'::jsonb
  END
) AS candidate(value)
LEFT JOIN bus_routes AS route ON route.id::text = candidate.value ->> 'id'
WHERE metric.mapping_status::text = 'AMBIGUOUS'
  AND btrim(metric.normalized_source_route_identifier) <> ''
GROUP BY metric.id, metric.source_route_identifier
HAVING count(DISTINCT route.id) = 1
   AND count(DISTINCT candidate.value ->> 'routeId') = 1
   AND bool_and(
     route.id IS NOT NULL
     AND candidate.value ->> 'routeId' IS NOT NULL
     AND candidate.value ->> 'routeId' = route.route_id
     AND lower(regexp_replace(btrim(normalize(metric.source_route_identifier, NFKC)), '[[:space:]]+', ' ', 'g')) =
         lower(regexp_replace(btrim(normalize(candidate.value ->> 'routeId', NFKC)), '[[:space:]]+', ' ', 'g'))
   );

CREATE TYPE passenger_metric_mapping_status_v2 AS ENUM (
  'MATCHED_VARIANT',
  'ROUTE_LEVEL_ONLY',
  'UNMATCHED',
  'CONFLICT'
);

ALTER TABLE passenger_route_metrics
  DROP CONSTRAINT IF EXISTS passenger_route_metrics_mapping_consistency;

ALTER TABLE passenger_route_metrics
  ALTER COLUMN mapping_status TYPE passenger_metric_mapping_status_v2
  USING (
    CASE mapping_status::text
      WHEN 'MATCHED' THEN 'MATCHED_VARIANT'
      WHEN 'AMBIGUOUS' THEN 'UNMATCHED'
      WHEN 'UNMATCHED' THEN 'UNMATCHED'
      WHEN 'MATCHED_VARIANT' THEN 'MATCHED_VARIANT'
      WHEN 'ROUTE_LEVEL_ONLY' THEN 'ROUTE_LEVEL_ONLY'
      WHEN 'CONFLICT' THEN 'CONFLICT'
      ELSE NULL
    END
  )::passenger_metric_mapping_status_v2;

ALTER TYPE passenger_metric_mapping_status RENAME TO passenger_metric_mapping_status_legacy;
ALTER TYPE passenger_metric_mapping_status_v2 RENAME TO passenger_metric_mapping_status;
DROP TYPE passenger_metric_mapping_status_legacy;

-- Preserve mapping_method and mapping_note, including prior manual/audit notes.
UPDATE passenger_route_metrics AS metric
SET
  mapping_status = 'ROUTE_LEVEL_ONLY',
  bus_route_id = family.bus_route_id,
  source_variant_id = NULL
FROM _passenger_metric_route_family_map AS family
WHERE metric.id = family.metric_id
  AND metric.mapping_status = 'UNMATCHED';

-- Blank route identifiers have no grouping identity: keep them UNMATCHED, never
-- combine them into a synthetic empty-route conflict group.
UPDATE passenger_route_metrics
SET
  mapping_status = 'UNMATCHED',
  bus_route_id = NULL,
  source_variant_id = NULL
WHERE btrim(normalized_source_route_identifier) = '';

UPDATE passenger_route_metrics
SET
  bus_route_id = NULL,
  source_variant_id = NULL
WHERE mapping_status = 'UNMATCHED';

WITH divergent_groups AS (
  SELECT normalized_source_route_identifier, month
  FROM passenger_route_metrics
  WHERE btrim(normalized_source_route_identifier) <> ''
  GROUP BY normalized_source_route_identifier, month
  HAVING count(DISTINCT passenger_count) > 1
)
UPDATE passenger_route_metrics AS metric
SET
  mapping_status = 'CONFLICT',
  bus_route_id = NULL,
  source_variant_id = NULL
FROM divergent_groups AS conflicting
WHERE metric.normalized_source_route_identifier = conflicting.normalized_source_route_identifier
  AND metric.month = conflicting.month;

ALTER TABLE passenger_route_metrics
  ADD CONSTRAINT passenger_route_metrics_mapping_consistency CHECK (
    (mapping_status = 'MATCHED_VARIANT' AND bus_route_id IS NOT NULL AND source_variant_id IS NOT NULL)
    OR (mapping_status = 'ROUTE_LEVEL_ONLY' AND bus_route_id IS NOT NULL AND source_variant_id IS NULL)
    OR (mapping_status IN ('UNMATCHED', 'CONFLICT') AND bus_route_id IS NULL AND source_variant_id IS NULL)
  ) NOT VALID;

ALTER TABLE passenger_route_metrics
  VALIDATE CONSTRAINT passenger_route_metrics_mapping_consistency;

DO $postflight$
DECLARE
  row_total bigint;
  conflict_groups bigint;
  conflict_rows bigint;
  integrity_failures bigint;
  batch_integrity_failures bigint;
BEGIN
  SELECT count(*) INTO row_total FROM passenger_route_metrics;
  SELECT count(DISTINCT (normalized_source_route_identifier, month)), count(*)
  INTO conflict_groups, conflict_rows
  FROM passenger_route_metrics
  WHERE mapping_status = 'CONFLICT'
    AND btrim(normalized_source_route_identifier) <> '';

  SELECT count(*) INTO integrity_failures
  FROM _passenger_metric_source_snapshot AS original
  FULL JOIN passenger_route_metrics AS current USING (id)
  WHERE original.id IS NULL
     OR current.id IS NULL
     OR original.import_batch_id IS DISTINCT FROM current.import_batch_id
     OR original.source_route_identifier IS DISTINCT FROM current.source_route_identifier
     OR original.normalized_source_route_identifier IS DISTINCT FROM current.normalized_source_route_identifier
     OR original.source_variant_identifier IS DISTINCT FROM current.source_variant_identifier
     OR original.route_candidates IS DISTINCT FROM current.route_candidates
     OR original.source_values IS DISTINCT FROM current.source_values
     OR original.source_file IS DISTINCT FROM current.source_file
     OR original.source_row IS DISTINCT FROM current.source_row
     OR original.month IS DISTINCT FROM current.month
     OR original.passenger_count IS DISTINCT FROM current.passenger_count
     OR original.trip_count IS DISTINCT FROM current.trip_count
     OR original.imported_at IS DISTINCT FROM current.imported_at
     OR original.mapping_method IS DISTINCT FROM current.mapping_method
     OR original.mapping_note IS DISTINCT FROM current.mapping_note;

  SELECT count(*) INTO batch_integrity_failures
  FROM _passenger_metric_batch_snapshot AS original
  FULL JOIN passenger_metric_import_batches AS current USING (id)
  WHERE original.id IS NULL
     OR current.id IS NULL
     OR original.source_file IS DISTINCT FROM current.source_file
     OR original.source_object_path IS DISTINCT FROM current.source_object_path
     OR original.source_sha256 IS DISTINCT FROM current.source_sha256
     OR original.source_row_count IS DISTINCT FROM current.source_row_count
     OR original.imported_at IS DISTINCT FROM current.imported_at;

  IF row_total <> 14594 OR conflict_groups <> 38 OR conflict_rows <> 76 THEN
    RAISE EXCEPTION 'Passenger mapping postflight failed: expected exactly 14,594 rows and 38 non-empty conflict groups (76 rows); found rows %, groups %, conflict rows %.',
      row_total, conflict_groups, conflict_rows;
  END IF;
  IF integrity_failures <> 0 OR batch_integrity_failures <> 0 THEN
    RAISE EXCEPTION 'Passenger mapping postflight failed: source/audit integrity mismatches %, private-object reference mismatches %.',
      integrity_failures, batch_integrity_failures;
  END IF;
  IF EXISTS (
    SELECT 1 FROM passenger_route_metrics
    WHERE (mapping_status = 'MATCHED_VARIANT' AND (bus_route_id IS NULL OR source_variant_id IS NULL))
       OR (mapping_status = 'ROUTE_LEVEL_ONLY' AND (bus_route_id IS NULL OR source_variant_id IS NOT NULL))
       OR (mapping_status IN ('UNMATCHED', 'CONFLICT') AND (bus_route_id IS NOT NULL OR source_variant_id IS NOT NULL))
       OR (mapping_status = 'CONFLICT' AND btrim(normalized_source_route_identifier) = '')
  ) THEN
    RAISE EXCEPTION 'Passenger mapping postflight failed: status-to-identity or empty-route invariant violation.';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM passenger_route_metrics
    WHERE btrim(normalized_source_route_identifier) <> ''
    GROUP BY normalized_source_route_identifier, month
    HAVING count(DISTINCT passenger_count) > 1
       AND bool_or(mapping_status <> 'CONFLICT')
  ) THEN
    RAISE EXCEPTION 'Passenger mapping postflight failed: a divergent non-empty route/month group is not fully CONFLICT.';
  END IF;

  RAISE NOTICE 'Passenger mapping QA: % rows; % MATCHED_VARIANT, % ROUTE_LEVEL_ONLY, % UNMATCHED, % CONFLICT rows across % non-empty conflict groups. Source/audit and private-object references verified.',
    row_total,
    (SELECT count(*) FROM passenger_route_metrics WHERE mapping_status = 'MATCHED_VARIANT'),
    (SELECT count(*) FROM passenger_route_metrics WHERE mapping_status = 'ROUTE_LEVEL_ONLY'),
    (SELECT count(*) FROM passenger_route_metrics WHERE mapping_status = 'UNMATCHED'),
    conflict_rows,
    conflict_groups;
END
$postflight$;

COMMIT;