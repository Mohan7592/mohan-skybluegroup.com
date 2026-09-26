import { Router, type IRouter } from "express";
import { and, count, desc, eq, isNotNull, sql } from "drizzle-orm";
import {
  GetInventorySourceHealthResponse,
  GetShelterSyncConflictsResponse,
  GetInventorySyncStatusResponse,
  ListInventorySyncHistoryResponse,
  RunInventorySyncResponse,
} from "@workspace/api-zod";
import {
  db, inventoryAssetsTable, inventorySyncChangesTable, inventorySyncRunsTable,
} from "@workspace/db";
import { syncShelterInventory } from "../lib/shelter-inventory-sync";
import { readShelterConflicts } from "../lib/shelter-conflicts";
import { logger } from "../lib/logger";

const router: IRouter = Router();
let syncRunning = false;

const configured = () => Boolean(process.env["SHELTER_MASTER_SHEET_ID"]?.trim());
export function syncIntervalMinutes(): number {
  const value = Number(process.env["INVENTORY_SYNC_INTERVAL_MINUTES"] ?? "15");
  return Number.isInteger(value) && value >= 0 && value <= 1440 ? value : 15;
}

async function run(trigger: string) {
  if (syncRunning) throw new Error("An inventory sync is already running");
  syncRunning = true;
  try {
    return await syncShelterInventory(trigger);
  } finally {
    syncRunning = false;
  }
}

export function startShelterSyncScheduler(): void {
  const minutes = syncIntervalMinutes();
  if (minutes === 0) return;
  const timer = setInterval(() => {
    if (!configured() || syncRunning) return;
    void run("scheduled").then((result) => {
      if (!result.success) logger.warn({ error: result.error }, "Scheduled shelter sync failed");
    }).catch((error) => logger.error({ error }, "Scheduled shelter sync crashed"));
  }, minutes * 60_000);
  timer.unref();
}

function serializeRun(run: typeof inventorySyncRunsTable.$inferSelect) {
  return {
    ...run,
    startedAt: run.startedAt.toISOString(),
    completedAt: run.completedAt?.toISOString() ?? null,
  };
}

router.get("/inventory/sync/status", async (_req, res): Promise<void> => {
  const [lastRun] = await db.select().from(inventorySyncRunsTable)
    .where(eq(inventorySyncRunsTable.sourceFamily, "BUS_SHELTER"))
    .orderBy(desc(inventorySyncRunsTable.startedAt)).limit(1);
  const [lastSuccess] = await db.select().from(inventorySyncRunsTable)
    .where(and(eq(inventorySyncRunsTable.sourceFamily, "BUS_SHELTER"), eq(inventorySyncRunsTable.status, "SUCCESS")))
    .orderBy(desc(inventorySyncRunsTable.completedAt)).limit(1);
  const lastSuccessfulSyncAt = lastSuccess?.completedAt ?? null;
  const minutes = syncIntervalMinutes();
  res.json(GetInventorySyncStatusResponse.parse({
    configured: configured(),
    connectionStatus: !configured() ? "not_configured" : lastRun?.status === "FAILED" ? "error"
      : lastSuccess ? "connected" : "awaiting_first_sync",
    sourceTitle: lastSuccess?.sourceTitle ?? null,
    lastSuccessfulSyncAt: lastSuccessfulSyncAt?.toISOString() ?? null,
    isStale: !lastSuccessfulSyncAt || Date.now() - lastSuccessfulSyncAt.getTime() > (minutes || 15) * 60_000,
    refreshIntervalMinutes: minutes,
    lastRun: lastRun ? serializeRun(lastRun) : null,
  }));
});

router.post("/inventory/sync", async (_req, res): Promise<void> => {
  if (!configured()) {
    res.status(409).json({ error: "SHELTER_MASTER_SHEET_ID is not configured. No inventory was changed." });
    return;
  }
  if (syncRunning) {
    res.status(409).json({ error: "An inventory sync is already in progress." });
    return;
  }
  const result = await run("manual");
  if (!result.success) {
    res.status(502).json({ error: result.error ?? "Google Sheets sync failed", syncRunId: result.syncRunId });
    return;
  }
  const [savedRun] = await db.select().from(inventorySyncRunsTable).where(eq(inventorySyncRunsTable.id, result.syncRunId!));
  res.json(RunInventorySyncResponse.parse(serializeRun(savedRun!)));
});

router.get("/inventory/sync/history", async (_req, res): Promise<void> => {
  const runs = await db.select().from(inventorySyncRunsTable)
    .where(eq(inventorySyncRunsTable.sourceFamily, "BUS_SHELTER"))
    .orderBy(desc(inventorySyncRunsTable.startedAt)).limit(30);
  const history = await Promise.all(runs.map(async (run) => ({
    ...serializeRun(run),
    changes: run.status !== "SUCCESS" ? [] : await db.select().from(inventorySyncChangesTable)
      .where(eq(inventorySyncChangesTable.syncRunId, run.id))
      .orderBy(desc(inventorySyncChangesTable.createdAt)).limit(100),
  })));
  res.json(ListInventorySyncHistoryResponse.parse(history));
});

router.get("/inventory/sync/conflicts", async (req, res): Promise<void> => {
  if (!configured()) {
    res.status(409).json({ error: "SHELTER_MASTER_SHEET_ID is not configured." });
    return;
  }
  try {
    res.json(GetShelterSyncConflictsResponse.parse(await readShelterConflicts()));
  } catch (error) {
    req.log.error({ error }, "Could not read shelter source conflicts");
    res.status(502).json({ error: "Could not read the current shelter source conflicts." });
  }
});

router.get("/inventory/sync/health", async (_req, res): Promise<void> => {
  const [lastRun] = await db.select().from(inventorySyncRunsTable)
    .where(eq(inventorySyncRunsTable.sourceFamily, "BUS_SHELTER"))
    .orderBy(desc(inventorySyncRunsTable.startedAt)).limit(1);
  const [lastSuccess] = await db.select().from(inventorySyncRunsTable)
    .where(and(eq(inventorySyncRunsTable.sourceFamily, "BUS_SHELTER"), eq(inventorySyncRunsTable.status, "SUCCESS")))
    .orderBy(desc(inventorySyncRunsTable.completedAt)).limit(1);
  const rows = await db.select({
    activeSourceRecords: sql<number>`count(*) filter (where ${inventoryAssetsTable.isActive} = true)`,
    removedRecords: sql<number>`count(*) filter (where ${inventoryAssetsTable.sourceLifecycleStatus} = 'REMOVED')`,
    invalidCoordinates: sql<number>`count(*) filter (where ${inventoryAssetsTable.latitude} is null or ${inventoryAssetsTable.longitude} is null)`,
    missingMediaType: sql<number>`count(*) filter (where ${inventoryAssetsTable.sourceMediaType} is null or trim(${inventoryAssetsTable.sourceMediaType}) = '')`,
    missingFromSource: sql<number>`count(*) filter (where ${inventoryAssetsTable.sourceLifecycleStatus} = 'MISSING_FROM_SOURCE')`,
    singleCount: sql<number>`count(*) filter (where ${inventoryAssetsTable.shelterConfiguration} = 'SINGLE')`,
    doubleCount: sql<number>`count(*) filter (where ${inventoryAssetsTable.shelterConfiguration} = 'DOUBLE')`,
    importedRecords: count(),
  }).from(inventoryAssetsTable).where(eq(inventoryAssetsTable.sourceFamily, "BUS_SHELTER"));
  const types = await db.select({
    type: inventoryAssetsTable.sourceMediaType, count: count(),
  }).from(inventoryAssetsTable)
    .where(and(eq(inventoryAssetsTable.sourceFamily, "BUS_SHELTER"), isNotNull(inventoryAssetsTable.sourceMediaType)))
    .groupBy(inventoryAssetsTable.sourceMediaType);
  const totals = rows[0];
  res.json(GetInventorySourceHealthResponse.parse({
    activeSourceRecords: Number(totals?.activeSourceRecords ?? 0),
    removedRecords: Number(totals?.removedRecords ?? 0),
    invalidCoordinates: Number(totals?.invalidCoordinates ?? 0),
    missingMediaType: Number(totals?.missingMediaType ?? 0),
    duplicateSourceKeys: lastRun?.duplicateCount ?? 0,
    newAssets: lastSuccess?.addedCount ?? 0,
    changedAssets: lastSuccess?.updatedCount ?? 0,
    missingFromSource: Number(totals?.missingFromSource ?? 0),
    singleCount: Number(totals?.singleCount ?? 0),
    doubleCount: Number(totals?.doubleCount ?? 0),
    sourceRows: lastSuccess?.sourceRows ?? 0,
    importedRecords: Number(totals?.importedRecords ?? 0),
    typeDistribution: Object.fromEntries(types.map((row) => [row.type!, Number(row.count)])),
  }));
});

export default router;