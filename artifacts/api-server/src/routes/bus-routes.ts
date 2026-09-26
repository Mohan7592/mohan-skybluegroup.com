import { Router, type IRouter } from "express";
import { and, desc, eq, isNotNull, or } from "drizzle-orm";
import {
  GetBusRouteParams,
  GetBusRouteResponse,
  GetBusRoutesHealthResponse,
  GetBusRoutesStatusResponse,
  ListBusRoutesQueryParams,
  ListBusRoutesResponse,
  SyncBusRoutesResponse,
} from "@workspace/api-zod";
import {
  busRouteSourceRowsTable,
  busRouteSyncRunsTable,
  busRoutesTable,
  db,
  projectBusRouteSelectionsTable,
} from "@workspace/db";
import { getBusRoutesSheetConnectionStatus } from "../lib/bus-routes-google-sheets";
import { syncBusRoutes } from "../lib/bus-routes-sync";
import { logger } from "../lib/logger";

const router: IRouter = Router();
let syncRunning = false;

function syncIntervalMinutes(): number {
  const configured = process.env.BUS_ROUTES_SYNC_INTERVAL_MINUTES?.trim();
  if (!configured) return 0;
  const minutes = Number(configured);
  return Number.isInteger(minutes) && minutes > 0 && minutes <= 1440 ? minutes : 0;
}

export function startBusRoutesSyncScheduler(): void {
  const minutes = syncIntervalMinutes();
  if (minutes === 0) return;
  const timer = setInterval(() => {
    if (!process.env.BUS_ROUTES_MASTER_SHEET_ID?.trim() || syncRunning) return;
    syncRunning = true;
    void syncBusRoutes("scheduled").then((result) => {
      if (result.status !== "SUCCESS") logger.warn({ error: result.error }, "Scheduled bus route sync failed");
    }).catch((error) => logger.error({ err: error }, "Scheduled bus route sync crashed"))
      .finally(() => { syncRunning = false; });
  }, minutes * 60_000);
  timer.unref();
}

function rawField(rawData: Record<string, unknown>, field: string): string {
  const target = field.toLocaleLowerCase().replace(/[^a-z0-9]/g, "");
  const key = Object.keys(rawData).find((candidate) =>
    candidate.toLocaleLowerCase().replace(/[^a-z0-9]/g, "") === target);
  const value = key === undefined ? "" : rawData[key];
  return value == null ? "" : String(value);
}

function rawFieldAny(rawData: Record<string, unknown>, ...fields: string[]): string | null {
  for (const field of fields) {
    const value = rawField(rawData, field);
    if (value.trim()) return value.trim();
  }
  return null;
}

function routeResponse(route: typeof busRoutesTable.$inferSelect, rows: typeof busRouteSourceRowsTable.$inferSelect[]) {
  const activeRows = rows.filter((row) => row.isActive);
  const variants = activeRows.map((row) => ({
    id: row.id,
    sourceIdentity: row.sourceIdentity,
    sheetName: row.sheetName,
    sourceRowNumber: row.sourceRowNumber,
    allocatedBusCount: row.allocatedBusCount,
    from: rawFieldAny(row.rawData, "Starting Station", "From"),
    to: rawFieldAny(row.rawData, "Ending station", "Ending Station", "To"),
    via: rawFieldAny(row.rawData, "Via"),
    depot: rawFieldAny(row.rawData, "Depot Name", "Depot"),
    sourceBusCount: row.allocatedBusCount,
    sourceSheet: row.sheetName,
    sourceRow: row.sourceRowNumber,
    lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
    originalSourceData: row.rawData,
    rawData: row.rawData,
  }));
  const depots = [...new Set(activeRows.map((row) => rawFieldAny(row.rawData, "Depot Name", "Depot"))
    .filter((value): value is string => !!value))].sort();
  return {
    id: route.id,
    routeId: route.routeId,
    normalizedRouteId: route.normalizedRouteId,
    isActive: route.isActive,
    sourceRowCount: activeRows.length,
    depots,
    variants,
  };
}

async function activeRouteRecords() {
  const routes = await db.select().from(busRoutesTable).where(eq(busRoutesTable.isActive, true));
  const rows = await db.select().from(busRouteSourceRowsTable).where(eq(busRouteSourceRowsTable.isActive, true));
  const rowsByRoute = new Map<string, typeof rows>();
  for (const row of rows) {
    const bucket = rowsByRoute.get(row.busRouteId) ?? [];
    bucket.push(row);
    rowsByRoute.set(row.busRouteId, bucket);
  }
  return routes
    .map((route) => routeResponse(route, rowsByRoute.get(route.id) ?? []))
    .filter((route) => route.sourceRowCount > 0);
}

router.get("/inventory/bus-routes", async (req, res): Promise<void> => {
  const parsed = ListBusRoutesQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { search, depot, limit, offset } = parsed.data;
  let routes = await activeRouteRecords();
  const query = search?.trim().toLocaleLowerCase();
  const depotQuery = depot?.trim().toLocaleLowerCase();
  if (query) {
    routes = routes.filter((route) => route.routeId.toLocaleLowerCase().includes(query) ||
      route.variants.some(({ rawData }) => [
        rawFieldAny(rawData, "Starting Station", "From"),
        rawFieldAny(rawData, "Ending station", "Ending Station", "To"),
        rawFieldAny(rawData, "Via"),
        rawFieldAny(rawData, "Full Routes"),
        rawFieldAny(rawData, "Depot Name", "Depot"),
      ].some((value) => value?.toLocaleLowerCase().includes(query))));
  }
  if (depotQuery) {
    routes = routes.filter((route) => route.variants.some(({ depot }) =>
      depot?.toLocaleLowerCase().includes(depotQuery)));
  }
  routes.sort((a, b) => a.normalizedRouteId.localeCompare(b.normalizedRouteId));
  res.json(ListBusRoutesResponse.parse({
    items: routes.slice(offset, offset + limit),
    total: routes.length,
    limit,
    offset,
  }));
});

router.get("/inventory/bus-routes/status", async (_req, res): Promise<void> => {
  const connection = await getBusRoutesSheetConnectionStatus();
  const [[lastRun], [lastSuccessfulRun]] = await Promise.all([
    db.select().from(busRouteSyncRunsTable)
      .orderBy(desc(busRouteSyncRunsTable.startedAt)).limit(1),
    db.select({ completedAt: busRouteSyncRunsTable.completedAt }).from(busRouteSyncRunsTable)
      .where(and(
        eq(busRouteSyncRunsTable.status, "SUCCESS"),
        isNotNull(busRouteSyncRunsTable.completedAt),
      ))
      .orderBy(desc(busRouteSyncRunsTable.completedAt)).limit(1),
  ]);
  const serializedRun = lastRun ? {
    ...lastRun,
    startedAt: lastRun.startedAt.toISOString(),
    completedAt: lastRun.completedAt?.toISOString() ?? lastRun.startedAt.toISOString(),
  } : null;
  res.json(GetBusRoutesStatusResponse.parse({
    configured: connection.configured,
    connected: connection.connected,
    physicalVehicleSourceConfigured: false,
    requiredTitle: connection.requiredTitle,
    spreadsheetTitle: connection.spreadsheetTitle,
    availableSheets: connection.availableSheets,
    activeRouteCount: (await activeRouteRecords()).length,
    lastRun: serializedRun,
    lastSuccessfulSyncAt: lastSuccessfulRun?.completedAt?.toISOString() ?? null,
    error: connection.error,
  }));
});

router.get("/inventory/bus-routes/health", async (_req, res): Promise<void> => {
  const [activeVariants, missingRoutes, selectedRows, lastRun, lastSuccessfulRun] = await Promise.all([
    db.select().from(busRouteSourceRowsTable).where(eq(busRouteSourceRowsTable.isActive, true)),
    db.select().from(busRoutesTable).where(eq(busRoutesTable.isActive, false)),
    db.select({
      selection: projectBusRouteSelectionsTable,
      source: busRouteSourceRowsTable,
      route: busRoutesTable,
    }).from(projectBusRouteSelectionsTable)
      .innerJoin(busRouteSourceRowsTable, eq(projectBusRouteSelectionsTable.sourceVariantId, busRouteSourceRowsTable.id))
      .innerJoin(busRoutesTable, eq(busRouteSourceRowsTable.busRouteId, busRoutesTable.id))
      .where(or(
        eq(busRouteSourceRowsTable.isActive, false),
        eq(busRoutesTable.isActive, false),
      )),
    db.select().from(busRouteSyncRunsTable).where(isNotNull(busRouteSyncRunsTable.completedAt))
      .orderBy(desc(busRouteSyncRunsTable.completedAt)).limit(1),
    db.select({ completedAt: busRouteSyncRunsTable.completedAt }).from(busRouteSyncRunsTable)
      .where(and(
        eq(busRouteSyncRunsTable.status, "SUCCESS"),
        isNotNull(busRouteSyncRunsTable.completedAt),
      ))
      .orderBy(desc(busRouteSyncRunsTable.completedAt)).limit(1),
  ]);
  const variantsByRoute = new Map<string, typeof activeVariants>();
  for (const variant of activeVariants) {
    const rows = variantsByRoute.get(variant.busRouteId) ?? [];
    rows.push(variant);
    variantsByRoute.set(variant.busRouteId, rows);
  }
  const duplicateRouteIds = [...variantsByRoute.values()].filter((variants) => variants.length > 1).length;
  const discoveredCount = (field: "from" | "to" | "via" | "depot" | "sourceBusCount") =>
    activeVariants.filter((variant) => field === "sourceBusCount"
      ? variant.allocatedBusCount === null
      : rawFieldAny(variant.rawData, ...(field === "from" ? ["Starting Station", "From"]
        : field === "to" ? ["Ending station", "Ending Station", "To"]
          : field === "via" ? ["Via"] : ["Depot Name", "Depot"])) === null).length;
  const serializedRun = lastRun?.[0] ? {
    ...lastRun[0],
    startedAt: lastRun[0].startedAt.toISOString(),
    completedAt: lastRun[0].completedAt!.toISOString(),
  } : null;
  const selectedMissingVariants = selectedRows.map(({ selection, source, route }) => ({
    projectId: selection.projectId,
    selectionId: selection.id,
    routeId: route.routeId,
    depot: rawFieldAny(source.rawData, "Depot Name", "Depot"),
    sourceSheet: source.sheetName,
    sourceRow: source.sourceRowNumber,
    proposedQuantity: selection.proposedQuantity,
    selectionStatus: selection.status,
    healthStatus: "MISSING_FROM_SOURCE" as const,
  }));
  res.json(GetBusRoutesHealthResponse.parse({
    validSourceRows: activeVariants.length,
    distinctRouteIds: variantsByRoute.size,
    duplicateRouteIds,
    missingFromCount: discoveredCount("from"),
    missingToCount: discoveredCount("to"),
    missingViaCount: discoveredCount("via"),
    missingDepotCount: discoveredCount("depot"),
    missingSourceBusCount: discoveredCount("sourceBusCount"),
    missingFromSourceRoutes: missingRoutes.length,
    inactiveRoutes: missingRoutes.map((route) => ({
      routeId: route.routeId,
      normalizedRouteId: route.normalizedRouteId,
      lastSeenAt: route.lastSeenAt?.toISOString() ?? null,
    })),
    selectedMissingVariants,
    lastSync: serializedRun,
    lastSuccessfulSyncAt: lastSuccessfulRun?.[0]?.completedAt?.toISOString() ?? null,
  }));
});

router.get("/inventory/bus-routes/:routeId", async (req, res): Promise<void> => {
  const parsed = GetBusRouteParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const target = parsed.data.routeId.trim().replace(/\s+/g, " ").toLocaleLowerCase();
  const [route] = await db.select().from(busRoutesTable)
    .where(eq(busRoutesTable.normalizedRouteId, target)).limit(1);
  if (!route?.isActive) {
    res.status(404).json({ error: "Bus route not found" });
    return;
  }
  const rows = await db.select().from(busRouteSourceRowsTable)
    .where(eq(busRouteSourceRowsTable.busRouteId, route.id));
  res.json(GetBusRouteResponse.parse(routeResponse(route, rows)));
});

router.post("/inventory/bus-routes/sync", async (_req, res): Promise<void> => {
  if (!process.env.BUS_ROUTES_MASTER_SHEET_ID?.trim()) {
    res.status(409).json({ error: "BUS_ROUTES_MASTER_SHEET_ID is not configured. No route data was changed." });
    return;
  }
  if (syncRunning) {
    res.status(409).json({ error: "A bus route sync is already in progress." });
    return;
  }
  syncRunning = true;
  try {
    const result = await syncBusRoutes("manual");
    if (result.status !== "SUCCESS") {
      res.status(502).json({ error: result.error ?? "Google Sheets sync failed", syncRunId: result.id });
      return;
    }
    res.json(SyncBusRoutesResponse.parse(result));
  } finally {
    syncRunning = false;
  }
});

export default router;