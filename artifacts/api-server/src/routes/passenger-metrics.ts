import { Router, type IRouter, type Request } from "express";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  busRoutesTable,
  busRouteSourceRowsTable,
  db,
  passengerMetricImportBatchesTable,
  passengerRouteMetricsTable,
} from "@workspace/db";
import {
  previewPassengerMetricsCsv,
  type PassengerImportMapping,
  type PassengerImportRow,
} from "../lib/passenger-metrics-import";
import {
  isPassengerMetricObjectReferenced,
  getActiveRouteTargets,
  mappedPreviewRows,
  persistPassengerMetricRows,
} from "../lib/passenger-metrics-service";
import {
  createPassengerCsvUpload,
  deleteUnreferencedPassengerCsvObject,
  MAX_PASSENGER_CSV_BYTES,
  passengerObjectCleanupCommand,
  readPassengerCsvObject,
} from "../lib/passenger-metrics-storage";
import { passengerImportQuality } from "../lib/passenger-metrics-analysis";
import { summarizePassengerMappingStatuses } from "../lib/passenger-metrics-import";
import { ensureWorkspaceOwner } from "./projects";

const router: IRouter = Router();
router.use("/inventory/passenger-metrics", (req, res, next) => {
  const authenticatedRequest = req as typeof req & { isAuthenticated?: () => boolean };
  if (typeof authenticatedRequest.isAuthenticated !== "function" || !authenticatedRequest.isAuthenticated()) {
    res.status(401).json({ error: "Sign in is required to access passenger source files and route metrics." });
    return;
  }
  next();
});
const rowMapping = {
  routeIdentifier: (value: unknown) => typeof value === "string" && value.trim().length > 0,
  month: (value: unknown) => typeof value === "string" && value.trim().length > 0,
  passengers: (value: unknown) => typeof value === "string" && value.trim().length > 0,
  trips: (value: unknown) => value === undefined || value === null || typeof value === "string",
};

type ManualOverride = { sourceRow: number; sourceVariantId: string; note: string };

type PassengerImportRequest = {
  objectPath: string;
  sourceFile: string;
  mapping: PassengerImportMapping;
  overrides?: ManualOverride[];
};

function importMetadata(req: Request): PassengerImportRequest {
  const value = req.body as Record<string, unknown> | undefined;
  const rawName = typeof value?.sourceFile === "string" ? value.sourceFile.trim() : "";
  const baseName = rawName.split(/[\\/]/).at(-1)?.replace(/[\u0000-\u001f\u007f]/g, "").trim() ?? "";
  if (!baseName || baseName.length > 240 || !/\.csv$/i.test(baseName)) {
    throw new Error("A CSV file name no longer than 240 characters is required.");
  }
  if (typeof value?.objectPath !== "string" || !/^\/objects\/passenger-metrics\/[0-9a-f-]{36}\.csv$/i.test(value.objectPath)) {
    throw new Error("A valid private passenger source upload is required.");
  }
  const mappingValue = value.mapping;
  if (!mappingValue || typeof mappingValue !== "object" || Array.isArray(mappingValue)) {
    throw new Error("The CSV column mapping is missing or invalid.");
  }
  const mapping = mappingValue as Record<string, unknown>;
  if (!rowMapping.routeIdentifier(mapping.routeIdentifier) ||
      !rowMapping.month(mapping.month) ||
      !rowMapping.passengers(mapping.passengers) ||
      !rowMapping.trips(mapping.trips) ||
      (mapping.routeVariant !== undefined && mapping.routeVariant !== null && typeof mapping.routeVariant !== "string")) {
    throw new Error("Choose a route, month and passenger-count column, with an optional trips column.");
  }
  const overrides: unknown = value.overrides ?? [];
  if (!Array.isArray(overrides) || overrides.length > 50 ||
      overrides.some((item) => !item || typeof item !== "object" ||
        !Number.isSafeInteger((item as ManualOverride).sourceRow) ||
        typeof (item as ManualOverride).sourceVariantId !== "string" ||
        typeof (item as ManualOverride).note !== "string")) {
    throw new Error("Manual route mapping choices must contain at most 50 valid row selections.");
  }
  return {
    objectPath: value.objectPath,
    sourceFile: baseName,
    mapping: {
      routeIdentifier: mapping.routeIdentifier as string,
      month: mapping.month as string,
      passengers: mapping.passengers as string,
      trips: typeof mapping.trips === "string" ? mapping.trips : null,
      routeVariant: typeof mapping.routeVariant === "string" ? mapping.routeVariant : null,
    },
    overrides: overrides as ManualOverride[],
  };
}

function publicPreviewRow(row: PassengerImportRow): Omit<PassengerImportRow, "sourceValues"> {
  const { sourceValues: _sourceValues, ...safeRow } = row;
  return safeRow;
}

router.post("/inventory/passenger-metrics/upload-url", async (req, res): Promise<void> => {
  await ensureWorkspaceOwner();
  const name = req.body?.name;
  const size = req.body?.size;
  if (typeof name !== "string" || name.length > 240 || !/\.csv$/i.test(name) ||
      !Number.isSafeInteger(size) || size <= 0 || size > MAX_PASSENGER_CSV_BYTES) {
    res.status(400).json({ error: "A CSV file between 1 byte and 20 MB is required." });
    return;
  }
  try {
    const upload = await createPassengerCsvUpload();
    res.json({ ...upload, maximumBytes: MAX_PASSENGER_CSV_BYTES });
  } catch (error) {
    res.status(503).json({ error: error instanceof Error ? error.message : "App Storage is unavailable." });
  }
});

router.delete("/inventory/passenger-metrics/uploads", async (req, res): Promise<void> => {
  await ensureWorkspaceOwner();
  const objectPath = req.body?.objectPath;
  if (typeof objectPath !== "string" || !/^\/objects\/passenger-metrics\/[0-9a-f-]{36}\.csv$/i.test(objectPath)) {
    res.status(400).json({ error: "A valid passenger upload path is required." });
    return;
  }
  const [priorImport] = await db.select({ id: passengerMetricImportBatchesTable.id })
    .from(passengerMetricImportBatchesTable)
    .where(eq(passengerMetricImportBatchesTable.sourceObjectPath, objectPath)).limit(1);
  if (priorImport) {
    res.status(409).json({ error: "Imported source objects are retained for audit and cannot be removed here." });
    return;
  }
  try {
    await deleteUnreferencedPassengerCsvObject(objectPath, isPassengerMetricObjectReferenced);
    res.sendStatus(204);
  } catch (error) {
    res.status(503).json({ error: error instanceof Error ? error.message : "Could not remove passenger source upload." });
  }
});

router.post("/inventory/passenger-metrics/preview", async (req, res): Promise<void> => {
  await ensureWorkspaceOwner();
  let metadata: ReturnType<typeof importMetadata>;
  try { metadata = importMetadata(req); }
  catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Invalid passenger import metadata." });
    return;
  }
  try {
    const [priorImport] = await db.select({ id: passengerMetricImportBatchesTable.id })
      .from(passengerMetricImportBatchesTable)
      .where(eq(passengerMetricImportBatchesTable.sourceObjectPath, metadata.objectPath)).limit(1);
    if (priorImport) {
      res.status(409).json({ error: "This source object has already been imported." });
      return;
    }
    const { csv } = await readPassengerCsvObject(metadata.objectPath);
    const routes = await getActiveRouteTargets();
    let preview;
    try {
      preview = previewPassengerMetricsCsv(csv, metadata.mapping, metadata.sourceFile, routes);
    } catch (error) {
      await deleteUnreferencedPassengerCsvObject(metadata.objectPath, isPassengerMetricObjectReferenced);
      throw error;
    }
    if (preview.summary.INVALID > 0) {
      await deleteUnreferencedPassengerCsvObject(metadata.objectPath, isPassengerMetricObjectReferenced);
      res.status(422).json({
        error: "The CSV contains invalid metric rows. No file or rows were retained; correct the source and upload again.",
        sourceFile: metadata.sourceFile,
        summary: preview.summary,
        rows: preview.rows.filter((row) => row.error).map(publicPreviewRow),
      });
      return;
    }
    if (!preview.rows.length) {
      await deleteUnreferencedPassengerCsvObject(metadata.objectPath, isPassengerMetricObjectReferenced);
      res.status(422).json({ error: "The CSV contains no passenger metric rows. No file or rows were retained." });
      return;
    }
    const rows = mappedPreviewRows(preview.rows, routes, metadata.mapping, metadata.overrides);
    const summary = summarizePassengerMappingStatuses(rows);
    res.json({
      sourceFile: metadata.sourceFile,
      sourceObjectPath: metadata.objectPath,
      headers: preview.headers,
      rows: rows.map(publicPreviewRow),
      summary: { ...summary, INVALID: 0 },
      quality: passengerImportQuality(rows),
    });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Could not preview passenger CSV." });
  }
});

router.post("/inventory/passenger-metrics/import", async (req, res): Promise<void> => {
  await ensureWorkspaceOwner();
  let metadata: ReturnType<typeof importMetadata>;
  try { metadata = importMetadata(req); }
  catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Invalid passenger import metadata." });
    return;
  }
  try {
    const [priorImport] = await db.select({ id: passengerMetricImportBatchesTable.id })
      .from(passengerMetricImportBatchesTable)
      .where(eq(passengerMetricImportBatchesTable.sourceObjectPath, metadata.objectPath)).limit(1);
    if (priorImport) {
      res.status(409).json({ error: "This source object has already been imported." });
      return;
    }
    const { csv, sha256 } = await readPassengerCsvObject(metadata.objectPath);
    const routes = await getActiveRouteTargets();
    let preview;
    try {
      preview = previewPassengerMetricsCsv(csv, metadata.mapping, metadata.sourceFile, routes);
    } catch (error) {
      await deleteUnreferencedPassengerCsvObject(metadata.objectPath, isPassengerMetricObjectReferenced);
      throw error;
    }
    if (preview.summary.INVALID > 0) {
      await deleteUnreferencedPassengerCsvObject(metadata.objectPath, isPassengerMetricObjectReferenced);
      res.status(422).json({ error: "Invalid metric rows were detected. The source object has been removed and no rows were imported.", summary: preview.summary });
      return;
    }
    const rows = mappedPreviewRows(preview.rows, routes, metadata.mapping, metadata.overrides);
    if (!rows.length) {
      await deleteUnreferencedPassengerCsvObject(metadata.objectPath, isPassengerMetricObjectReferenced);
      res.status(400).json({ error: "There are no metric rows to import. The source object has been removed." });
      return;
    }
    let result;
    try {
      result = await persistPassengerMetricRows({
        rows, sourceFile: metadata.sourceFile, sourceObjectPath: metadata.objectPath, sha256, overrides: metadata.overrides,
      });
    } catch (error) {
      try {
        await deleteUnreferencedPassengerCsvObject(metadata.objectPath, isPassengerMetricObjectReferenced);
      } catch (cleanupError) {
        const cleanupReason = cleanupError instanceof Error ? cleanupError.message : "unknown App Storage cleanup error";
        res.status(500).json({
          error: `Passenger import failed and staged-object cleanup did not complete: ${cleanupReason}`,
          orphanObjectPath: metadata.objectPath,
          cleanupCommand: passengerObjectCleanupCommand(metadata.objectPath),
        });
        return;
      }
      const isDuplicate = error instanceof Error && error.name === "DuplicatePassengerSourceError";
      res.status(isDuplicate ? 409 : 400).json({
        error: error instanceof Error ? error.message : "Could not import passenger CSV.",
      });
      return;
    }
    res.status(201).json({
      importBatch: result.importBatch,
      rowCount: result.rowCount,
      summary: result.summary,
      quality: result.quality,
      note: "Passenger counts are route-level ridership evidence. They are not advertising impressions, audience reach or vehicle availability.",
    });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Could not import passenger CSV." });
  }
});

router.get("/inventory/passenger-metrics/imports", async (_req, res): Promise<void> => {
  await ensureWorkspaceOwner();
  const batches = await db.select().from(passengerMetricImportBatchesTable)
    .orderBy(desc(passengerMetricImportBatchesTable.importedAt))
    .limit(50);
  if (!batches.length) { res.json([]); return; }
  const metrics = await db.select({
    importBatchId: passengerRouteMetricsTable.importBatchId,
    mappingStatus: passengerRouteMetricsTable.mappingStatus,
  }).from(passengerRouteMetricsTable)
    .where(inArray(passengerRouteMetricsTable.importBatchId, batches.map((batch) => batch.id)));
  const counts = new Map<string, { MATCHED_VARIANT: number; ROUTE_LEVEL_ONLY: number; UNMATCHED: number; CONFLICT: number }>();
  for (const row of metrics) {
    const summary = counts.get(row.importBatchId) ?? { MATCHED_VARIANT: 0, ROUTE_LEVEL_ONLY: 0, UNMATCHED: 0, CONFLICT: 0 };
    summary[row.mappingStatus] += 1;
    counts.set(row.importBatchId, summary);
  }
  res.json(batches.map((batch) => ({
    ...batch,
    summary: counts.get(batch.id) ?? { MATCHED_VARIANT: 0, ROUTE_LEVEL_ONLY: 0, UNMATCHED: 0, CONFLICT: 0 },
  })));
});

router.get("/inventory/passenger-metrics", async (req, res): Promise<void> => {
  await ensureWorkspaceOwner();
  const limitValue = Number(req.query.limit ?? 250);
  const limit = Number.isInteger(limitValue) ? Math.max(1, Math.min(1000, limitValue)) : 250;
  const rows = await db.select({
    id: passengerRouteMetricsTable.id,
    importBatchId: passengerRouteMetricsTable.importBatchId,
    sourceRouteIdentifier: passengerRouteMetricsTable.sourceRouteIdentifier,
    normalizedSourceRouteIdentifier: passengerRouteMetricsTable.normalizedSourceRouteIdentifier,
    sourceVariantIdentifier: passengerRouteMetricsTable.sourceVariantIdentifier,
    sourceValues: passengerRouteMetricsTable.sourceValues,
    routeId: busRoutesTable.routeId,
    busRouteId: passengerRouteMetricsTable.busRouteId,
    sourceVariantId: passengerRouteMetricsTable.sourceVariantId,
    routeCandidates: passengerRouteMetricsTable.routeCandidates,
    mappingStatus: passengerRouteMetricsTable.mappingStatus,
    mappingMethod: passengerRouteMetricsTable.mappingMethod,
    mappingNote: passengerRouteMetricsTable.mappingNote,
    month: passengerRouteMetricsTable.month,
    passengerCount: passengerRouteMetricsTable.passengerCount,
    tripCount: passengerRouteMetricsTable.tripCount,
    sourceFile: passengerRouteMetricsTable.sourceFile,
    sourceRow: passengerRouteMetricsTable.sourceRow,
    importedAt: passengerRouteMetricsTable.importedAt,
  }).from(passengerRouteMetricsTable)
    .leftJoin(busRoutesTable, eq(passengerRouteMetricsTable.busRouteId, busRoutesTable.id))
    .orderBy(desc(passengerRouteMetricsTable.importedAt), desc(passengerRouteMetricsTable.month))
    .limit(limit);
  res.json(rows);
});

router.put("/inventory/passenger-metrics/:metricId/mapping", async (req, res): Promise<void> => {
  await ensureWorkspaceOwner();
  const metricId = req.params.metricId;
  const sourceVariantId = req.body?.sourceVariantId;
  const note = req.body?.note;
  if (typeof metricId !== "string" || !/^[0-9a-f-]{36}$/i.test(metricId) ||
      typeof sourceVariantId !== "string" || !/^[0-9a-f-]{36}$/i.test(sourceVariantId) ||
      typeof note !== "string" || note.trim().length < 10 || note.length > 500) {
    res.status(400).json({ error: "Choose an existing bus route and provide a 10–500 character mapping rationale." });
    return;
  }
  const [metric] = await db.select().from(passengerRouteMetricsTable)
    .where(eq(passengerRouteMetricsTable.id, metricId)).limit(1);
  if (!metric) { res.status(404).json({ error: "Passenger metric row not found." }); return; }
  if (metric.mappingStatus === "MATCHED_VARIANT" || metric.mappingStatus === "CONFLICT") {
    res.status(409).json({ error: "This metric is already mapped. Review a separate ambiguous or unmatched metric instead." });
    return;
  }
  const candidate = metric.routeCandidates.find((item) => item.sourceVariantId === sourceVariantId);
  if (!candidate) {
    res.status(409).json({ error: "This route was not identified as a possible candidate. It cannot be force-mapped." });
    return;
  }
  const sameRouteVariants = metric.routeCandidates.filter((item) => item.routeId === candidate.routeId);
  if (sameRouteVariants.length > 1) {
    const suppliedVariant = metric.sourceVariantIdentifier?.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
    const matchingVariants = sameRouteVariants.filter((item) => [
      item.sourceVariantId ?? "",
      item.sourceIdentity ?? "",
      item.sourceSheet ?? "",
      item.sourceRow == null ? "" : String(item.sourceRow),
    ].some((value) => value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US") === suppliedVariant));
    if (!suppliedVariant || matchingVariants.length !== 1 || matchingVariants[0]?.sourceVariantId !== candidate.sourceVariantId) {
      res.status(409).json({ error: "This row does not identify a specific source variant; ridership cannot be assigned across variants." });
      return;
    }
  }
  const [variant] = await db.select({
    id: busRouteSourceRowsTable.id,
    busRouteId: busRouteSourceRowsTable.busRouteId,
    isActive: busRouteSourceRowsTable.isActive,
  }).from(busRouteSourceRowsTable)
    .where(and(eq(busRouteSourceRowsTable.id, sourceVariantId), eq(busRouteSourceRowsTable.isActive, true)))
    .limit(1);
  if (!variant || variant.busRouteId !== candidate.id) { res.status(404).json({ error: "Active route variant not found." }); return; }
  const [updated] = await db.update(passengerRouteMetricsTable).set({
    busRouteId: candidate.id,
    sourceVariantId: variant.id,
    mappingStatus: "MATCHED_VARIANT",
    mappingMethod: "MANUAL_CONFIRMED",
    mappingNote: note.trim(),
  }).where(and(eq(passengerRouteMetricsTable.id, metric.id), eq(passengerRouteMetricsTable.mappingStatus, metric.mappingStatus)))
    .returning();
  if (!updated) { res.status(409).json({ error: "The mapping changed while it was being reviewed. Refresh and try again." }); return; }
  res.json({ ...updated, routeId: candidate.routeId });
});

export default router;