import { and, eq, inArray, sql } from "drizzle-orm";
import {
  busRouteSourceRowsTable,
  busRoutesTable,
  db,
  passengerMetricImportBatchesTable,
  passengerRouteMetricsTable,
} from "@workspace/db";
import { passengerImportQuality } from "./passenger-metrics-analysis";
import type {
  PassengerImportMapping,
  PassengerImportRow,
  PassengerRouteCandidate,
  PassengerRouteTarget,
  RouteMappingStatus,
} from "./passenger-metrics-import";
import {
  isPassengerRouteMonthConflictEligible,
  passengerRouteMonthKey,
  reconcilePassengerRouteMonthConflicts,
} from "./passenger-metrics-import";

type ManualOverride = { sourceRow: number; sourceVariantId: string; note: string };

export class DuplicatePassengerSourceError extends Error {
  constructor(batchId: string) {
    super(`This exact CSV has already been imported (source SHA-256 matches batch ${batchId}); refusing a duplicate import.`);
    this.name = "DuplicatePassengerSourceError";
  }
}

export async function findPassengerMetricImportBySha256(sha256: string) {
  const [batch] = await db.select({
    id: passengerMetricImportBatchesTable.id,
    sourceFile: passengerMetricImportBatchesTable.sourceFile,
    sourceObjectPath: passengerMetricImportBatchesTable.sourceObjectPath,
    importedAt: passengerMetricImportBatchesTable.importedAt,
  }).from(passengerMetricImportBatchesTable)
    .where(eq(passengerMetricImportBatchesTable.sourceSha256, sha256))
    .limit(1);
  return batch ?? null;
}

export async function isPassengerMetricObjectReferenced(objectPath: string): Promise<boolean> {
  const [batch] = await db.select({ id: passengerMetricImportBatchesTable.id })
    .from(passengerMetricImportBatchesTable)
    .where(eq(passengerMetricImportBatchesTable.sourceObjectPath, objectPath))
    .limit(1);
  return !!batch;
}

function rawSourceValue(rawData: Record<string, unknown>, ...headers: string[]): string | null {
  const normalizedHeaders = new Set(headers.map((header) => header.toLocaleLowerCase().replace(/[^a-z0-9]/g, "")));
  for (const [header, value] of Object.entries(rawData)) {
    if (!normalizedHeaders.has(header.toLocaleLowerCase().replace(/[^a-z0-9]/g, "")) || value == null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return null;
}

export async function getActiveRouteTargets(): Promise<PassengerRouteTarget[]> {
  const rows = await db.select({
    id: busRoutesTable.id,
    routeId: busRoutesTable.routeId,
    normalizedRouteId: busRoutesTable.normalizedRouteId,
    sourceVariantId: busRouteSourceRowsTable.id,
    sourceIdentity: busRouteSourceRowsTable.sourceIdentity,
    sourceSheet: busRouteSourceRowsTable.sheetName,
    sourceRow: busRouteSourceRowsTable.sourceRowNumber,
    sourceBusCount: busRouteSourceRowsTable.allocatedBusCount,
    rawData: busRouteSourceRowsTable.rawData,
  }).from(busRouteSourceRowsTable)
    .innerJoin(busRoutesTable, eq(busRouteSourceRowsTable.busRouteId, busRoutesTable.id))
    .where(and(eq(busRoutesTable.isActive, true), eq(busRouteSourceRowsTable.isActive, true)));
  return rows.map(({ rawData, ...route }) => ({
    ...route,
    from: rawSourceValue(rawData, "Starting Station", "From"),
    to: rawSourceValue(rawData, "Ending Station", "To"),
    via: rawSourceValue(rawData, "Via"),
  }));
}

function variantIdentifierMatches(
  row: PassengerImportRow,
  mapping: PassengerImportMapping,
  candidate: PassengerRouteCandidate,
): boolean {
  if (!mapping.routeVariant) return false;
  const supplied = row.sourceValues[mapping.routeVariant]?.trim();
  if (!supplied) return false;
  const normalized = supplied.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
  return [
    candidate.sourceVariantId ?? "",
    candidate.sourceIdentity ?? "",
    candidate.sourceSheet ?? "",
    candidate.sourceRow == null ? "" : String(candidate.sourceRow),
  ].some((value) => value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US") === normalized);
}

export function mappedPreviewRows(
  rows: PassengerImportRow[],
  routes: PassengerRouteTarget[],
  mapping: PassengerImportMapping,
  overrides: ManualOverride[] = [],
): PassengerImportRow[] {
  const routeByVariant = new Map(routes.filter((route) => route.sourceVariantId)
    .map((route) => [route.sourceVariantId!, route]));
  const overrideByRow = new Map(overrides.map((override) => [override.sourceRow, override]));
  for (const override of overrides) {
    if (!Number.isSafeInteger(override.sourceRow) || !override.sourceVariantId ||
        override.note.trim().length < 10 || override.note.length > 500) {
      throw new Error("Every manual route choice needs a reason of 10–500 characters.");
    }
  }
  return rows.map((row) => {
    const override = overrideByRow.get(row.sourceRow);
    if (!override) return row;
    if (row.error || row.mappingStatus === "MATCHED_VARIANT" || row.mappingStatus === "CONFLICT") {
      throw new Error(`Source row ${row.sourceRow} cannot be manually remapped.`);
    }
    const route = routeByVariant.get(override.sourceVariantId);
    if (!route || !row.routeCandidates.some((candidate) => candidate.id === route.id)) {
      throw new Error(`The selected route for source row ${row.sourceRow} was not identified as a candidate; it cannot be force-mapped.`);
    }
    const candidate = row.routeCandidates.find((item) => item.sourceVariantId === route.sourceVariantId);
    const sameRouteVariants = row.routeCandidates.filter((item) => item.routeId === route.routeId);
    const uniquelyIdentifiedVariants = sameRouteVariants.filter((item) => variantIdentifierMatches(row, mapping, item));
    if (sameRouteVariants.length > 1 &&
        (!candidate || uniquelyIdentifiedVariants.length !== 1 || uniquelyIdentifiedVariants[0]?.sourceVariantId !== candidate.sourceVariantId)) {
      throw new Error(`Source row ${row.sourceRow} does not identify one specific route variant; its ridership cannot be assigned to any variant.`);
    }
    return {
      ...row,
      mappingStatus: "MATCHED_VARIANT",
      busRouteId: route.id,
      sourceVariantId: route.sourceVariantId ?? null,
      matchedRouteId: route.routeId,
    };
  });
}

export async function persistPassengerMetricRows(input: {
  rows: PassengerImportRow[];
  sourceFile: string;
  sourceObjectPath: string;
  sha256: string;
  overrides?: Array<{ sourceRow: number; note: string }>;
  auditMappingNote?: string;
}): Promise<{
  importBatch: typeof passengerMetricImportBatchesTable.$inferSelect;
  rowCount: number;
  summary: Record<RouteMappingStatus, number>;
  quality: ReturnType<typeof passengerImportQuality>;
}> {
  const { rows, sourceFile, sourceObjectPath, sha256, overrides = [], auditMappingNote } = input;
  if (!rows.length) throw new Error("There are no passenger metric rows to import.");
  if (rows.some((row) => row.error)) throw new Error("Invalid passenger metric rows cannot be committed.");
  const priorBatch = await findPassengerMetricImportBySha256(sha256);
  if (priorBatch) throw new DuplicatePassengerSourceError(priorBatch.id);
  const importedAt = new Date();
  type StoredBatchRows = {
    batch: typeof passengerMetricImportBatchesTable.$inferSelect;
    inserted: Array<typeof passengerRouteMetricsTable.$inferSelect>;
  };
  let result: StoredBatchRows;
  try {
    result = await db.transaction<StoredBatchRows>(async (tx) => {
      const [batch] = await tx.insert(passengerMetricImportBatchesTable).values({
        sourceFile,
        sourceObjectPath,
        sourceSha256: sha256,
        sourceRowCount: rows.length,
        importedAt,
      }).returning();
      if (!batch) throw new Error("Passenger import batch could not be created.");
      const incomingGroups = new Map<string, PassengerImportRow[]>();
      for (const row of rows) {
        if (!isPassengerRouteMonthConflictEligible(row)) continue;
        const key = passengerRouteMonthKey(row);
        incomingGroups.set(key, [...(incomingGroups.get(key) ?? []), row]);
      }
      const orderedKeys = [...incomingGroups.keys()].sort();
      for (const key of orderedKeys) {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
      }
      const existingByKey = new Map<string, Array<{
        id: string;
        normalizedSourceRouteIdentifier: string;
        month: string;
        passengerCount: number;
        mappingStatus: RouteMappingStatus;
      }>>();
      for (const key of orderedKeys) {
        const group = incomingGroups.get(key)!;
        const existing = await tx.select({
          id: passengerRouteMetricsTable.id,
          normalizedSourceRouteIdentifier: passengerRouteMetricsTable.normalizedSourceRouteIdentifier,
          month: passengerRouteMetricsTable.month,
          passengerCount: passengerRouteMetricsTable.passengerCount,
          mappingStatus: passengerRouteMetricsTable.mappingStatus,
        }).from(passengerRouteMetricsTable)
          .where(and(
            eq(passengerRouteMetricsTable.normalizedSourceRouteIdentifier, group[0]!.normalizedSourceRouteIdentifier),
            eq(passengerRouteMetricsTable.month, group[0]!.month),
          ))
          .for("update");
        existingByKey.set(key, existing);
      }
      const reconciliation = reconcilePassengerRouteMonthConflicts(
        rows,
        [...existingByKey.values()].flat(),
      );
      for (const key of reconciliation.conflictKeys) {
        const existingIds = (existingByKey.get(key) ?? []).map((row) => row.id);
        if (existingIds.length) {
          await tx.update(passengerRouteMetricsTable).set({
            mappingStatus: "CONFLICT",
            busRouteId: null,
            sourceVariantId: null,
          }).where(inArray(passengerRouteMetricsTable.id, existingIds));
        }
      }
      const rowsToSave = reconciliation.rows.map((row) => {
        const override = overrides.find((item) => item.sourceRow === row.sourceRow);
        return {
          importBatchId: batch.id,
          sourceRouteIdentifier: row.sourceRouteIdentifier,
          normalizedSourceRouteIdentifier: row.normalizedSourceRouteIdentifier,
          sourceVariantIdentifier: row.sourceVariantIdentifier,
          busRouteId: row.busRouteId,
          sourceVariantId: row.sourceVariantId,
          routeCandidates: row.routeCandidates,
          mappingStatus: row.mappingStatus,
          mappingMethod: override ? "MANUAL_CONFIRMED" : row.mappingStatus === "MATCHED_VARIANT"
            ? "EXACT_NORMALIZED_IDENTIFIER"
            : row.mappingStatus === "ROUTE_LEVEL_ONLY" ? "ROUTE_FAMILY_ONLY"
              : row.mappingStatus === "CONFLICT" ? "CONFLICTING_SOURCE_COUNTS" : "NO_SAFE_EXACT_MATCH",
          mappingNote: override?.note.trim() ?? auditMappingNote?.trim() ??
            (row.mappingStatus === "ROUTE_LEVEL_ONLY"
              ? "Passenger evidence maps to this route family only; it is not variant-specific."
              : row.mappingStatus === "CONFLICT"
                ? "Conflicting passenger values for the same route and month; excluded from trends pending review."
                : null),
          month: row.month,
          passengerCount: row.passengerCount,
          tripCount: row.tripCount,
          sourceFile,
          sourceRow: row.sourceRow,
          sourceValues: row.sourceValues,
          importedAt,
        };
      });
      const inserted: StoredBatchRows["inserted"] = [];
      for (let index = 0; index < rowsToSave.length; index += 500) {
        inserted.push(...await tx.insert(passengerRouteMetricsTable)
          .values(rowsToSave.slice(index, index + 500)).returning());
      }
      return { batch, inserted };
    });
  } catch (error) {
    const databaseError = error as { code?: string; constraint?: string };
    if (databaseError.code === "23505" &&
        databaseError.constraint === "passenger_metric_import_source_sha256_unique") {
      const winner = await findPassengerMetricImportBySha256(sha256);
      throw new DuplicatePassengerSourceError(winner?.id ?? "another concurrent import");
    }
    throw error;
  }
  const summary = result.inserted.reduce<Record<RouteMappingStatus, number>>((counts, metric) => {
    counts[metric.mappingStatus] += 1;
    return counts;
  }, { MATCHED_VARIANT: 0, ROUTE_LEVEL_ONLY: 0, UNMATCHED: 0, CONFLICT: 0 });
  return {
    importBatch: result.batch,
    rowCount: result.inserted.length,
    summary,
    quality: passengerImportQuality(result.inserted.map((metric) => ({
      sourceRow: metric.sourceRow,
      sourceRouteIdentifier: metric.sourceRouteIdentifier,
      month: metric.month,
      mappingStatus: metric.mappingStatus,
      routeCandidates: metric.routeCandidates,
    }))),
  };
}