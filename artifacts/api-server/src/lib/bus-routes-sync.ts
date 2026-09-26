import { desc, eq } from "drizzle-orm";
import {
  busRouteSourceRowsTable,
  busRouteSyncRunsTable,
  busRoutesTable,
  db,
} from "@workspace/db";
import { logger } from "./logger";
import { readBusRouteSourceSheets } from "./bus-routes-google-sheets";
import {
  isSameBusRouteSourceRow,
  planBusRouteSourceRows,
  reconcileBusRouteSourceIdentities,
  validateBusRouteSourceShrinkage,
} from "./bus-route-sync-plan";
export {
  isSameBusRouteSourceRow,
  planBusRouteSourceRows,
  reconcileBusRouteSourceIdentities,
  validateBusRouteSourceShrinkage,
} from "./bus-route-sync-plan";

export type BusRouteSyncResult = {
  id: string | null;
  status: "SUCCESS" | "FAILED";
  trigger: string;
  sourceTitle: string | null;
  discoveredSheets: Array<{ name: string; kind: "route" | "vehicle"; dataRows: number; headers: string[] }>;
  skippedSheets: string[];
  sourceRows: number;
  distinctRoutes: number;
  addedCount: number;
  updatedCount: number;
  unchangedCount: number;
  inactiveCount: number;
  error: string | null;
  startedAt: string;
  completedAt: string;
};

let activeSync: Promise<BusRouteSyncResult> | null = null;

export async function syncBusRoutes(trigger: string): Promise<BusRouteSyncResult> {
  if (activeSync) return activeSync;
  activeSync = performSync(trigger);
  try {
    return await activeSync;
  } finally {
    activeSync = null;
  }
}

async function performSync(trigger: string): Promise<BusRouteSyncResult> {
  const startedAt = new Date();
  const result: BusRouteSyncResult = {
    id: null,
    status: "FAILED",
    trigger,
    sourceTitle: null,
    discoveredSheets: [],
    skippedSheets: [],
    sourceRows: 0,
    distinctRoutes: 0,
    addedCount: 0,
    updatedCount: 0,
    unchangedCount: 0,
    inactiveCount: 0,
    error: null,
    startedAt: startedAt.toISOString(),
    completedAt: startedAt.toISOString(),
  };
  let runId: string | null = null;
  try {
    const [run] = await db.insert(busRouteSyncRunsTable).values({
      status: "RUNNING",
      trigger: trigger.trim() || "manual",
    }).returning({ id: busRouteSyncRunsTable.id });
    if (!run) throw new Error("Could not create bus route sync run");
    runId = run.id;
    result.id = runId;

    const source = await readBusRouteSourceSheets();
    const plan = planBusRouteSourceRows(source.rows);
    if (!source.rows.length) throw new Error("No route rows were discovered; no existing route references were changed");
    const [previousSuccess] = await db.select({
      sourceRows: busRouteSyncRunsTable.sourceRows,
      discoveredSheets: busRouteSyncRunsTable.discoveredSheets,
    }).from(busRouteSyncRunsTable)
      .where(eq(busRouteSyncRunsTable.status, "SUCCESS"))
      .orderBy(desc(busRouteSyncRunsTable.completedAt)).limit(1);
    validateBusRouteSourceShrinkage(
      { sourceRows: plan.sourceRows, discoveredSheets: source.discoveredSheets },
      previousSuccess ?? null,
    );
    result.sourceTitle = source.title;
    result.discoveredSheets = source.discoveredSheets;
    result.skippedSheets = source.discoveredSheets.filter((sheet) => sheet.kind === "vehicle").map((sheet) => sheet.name);
    result.sourceRows = plan.sourceRows;
    result.distinctRoutes = plan.distinctRoutes;

    await db.transaction(async (tx) => {
      const currentRoutes = await tx.select().from(busRoutesTable);
      const routesByKey = new Map(currentRoutes.map((route) => [route.normalizedRouteId, route]));
      const currentRows = await tx.select().from(busRouteSourceRowsTable);
      reconcileBusRouteSourceIdentities(source.rows, currentRows);
      planBusRouteSourceRows(source.rows);
      const rowsByIdentity = new Map(currentRows.map((row) => [`${row.sheetName}\u0000${row.sourceIdentity}`, row]));
      const now = new Date();
      const seenRoutes = new Set<string>();
      const seenRows = new Set<string>();

      for (const sourceRow of source.rows) {
        seenRoutes.add(sourceRow.normalizedRouteId);
        const rowIdentity = `${sourceRow.sheetName}\u0000${sourceRow.sourceIdentity}`;
        seenRows.add(rowIdentity);
        let parent = routesByKey.get(sourceRow.normalizedRouteId);
        if (!parent) {
          const [created] = await tx.insert(busRoutesTable).values({
            normalizedRouteId: sourceRow.normalizedRouteId,
            routeId: sourceRow.routeId,
            isActive: true,
            lastSeenAt: now,
          }).returning();
          if (!created) throw new Error(`Could not add route ${sourceRow.routeId}`);
          parent = created;
          routesByKey.set(parent.normalizedRouteId, parent);
          result.addedCount += 1;
        } else if (!parent.isActive) {
          await tx.update(busRoutesTable).set({
            isActive: true,
            lastSeenAt: now,
            updatedAt: now,
          }).where(eq(busRoutesTable.id, parent.id));
          parent = { ...parent, isActive: true, lastSeenAt: now };
          routesByKey.set(parent.normalizedRouteId, parent);
          result.updatedCount += 1;
        } else {
          await tx.update(busRoutesTable).set({ lastSeenAt: now }).where(eq(busRoutesTable.id, parent.id));
        }

        const existingRow = rowsByIdentity.get(rowIdentity);
        if (!existingRow) {
          const [created] = await tx.insert(busRouteSourceRowsTable).values({
            busRouteId: parent.id,
            sheetName: sourceRow.sheetName,
            sourceIdentity: sourceRow.sourceIdentity,
            sourceRowNumber: sourceRow.sourceRowNumber,
            allocatedBusCount: sourceRow.allocatedBusCount,
            rawData: sourceRow.rawData,
            isActive: true,
            lastSeenAt: now,
          }).returning();
          if (!created) throw new Error(`Could not store ${sourceRow.sheetName} row ${sourceRow.sourceRowNumber}`);
          rowsByIdentity.set(rowIdentity, created);
          // Parent creation is already counted; an additional sheet variant is not another route.
          continue;
        }
        const changed = !isSameBusRouteSourceRow(existingRow, sourceRow, parent.id) ||
          existingRow.sourceRowNumber !== sourceRow.sourceRowNumber ||
          existingRow.allocatedBusCount !== sourceRow.allocatedBusCount;
        if (changed) {
          await tx.update(busRouteSourceRowsTable).set({
            busRouteId: parent.id,
            sourceRowNumber: sourceRow.sourceRowNumber,
            allocatedBusCount: sourceRow.allocatedBusCount,
            rawData: sourceRow.rawData,
            isActive: true,
            lastSeenAt: now,
            updatedAt: now,
          }).where(eq(busRouteSourceRowsTable.id, existingRow.id));
          rowsByIdentity.set(rowIdentity, {
            ...existingRow,
            busRouteId: parent.id,
            sourceRowNumber: sourceRow.sourceRowNumber,
            allocatedBusCount: sourceRow.allocatedBusCount,
            rawData: sourceRow.rawData,
            isActive: true,
            lastSeenAt: now,
          });
          result.updatedCount += 1;
        } else {
          await tx.update(busRouteSourceRowsTable).set({ lastSeenAt: now }).where(eq(busRouteSourceRowsTable.id, existingRow.id));
          result.unchangedCount += 1;
        }
      }

      for (const row of currentRows) {
        const identity = `${row.sheetName}\u0000${row.sourceIdentity}`;
        if (seenRows.has(identity) || !row.isActive) continue;
        await tx.update(busRouteSourceRowsTable).set({ isActive: false, updatedAt: now })
          .where(eq(busRouteSourceRowsTable.id, row.id));
        result.inactiveCount += 1;
      }
      for (const route of currentRoutes) {
        if (!route.isActive || seenRoutes.has(route.normalizedRouteId)) continue;
        await tx.update(busRoutesTable).set({ isActive: false, updatedAt: now })
          .where(eq(busRoutesTable.id, route.id));
        result.inactiveCount += 1;
      }

      await tx.update(busRouteSyncRunsTable).set({
        status: "SUCCESS",
        sourceTitle: source.title,
        discoveredSheets: source.discoveredSheets,
        skippedSheets: result.skippedSheets,
        sourceRows: result.sourceRows,
        distinctRoutes: result.distinctRoutes,
        addedCount: result.addedCount,
        updatedCount: result.updatedCount,
        unchangedCount: result.unchangedCount,
        inactiveCount: result.inactiveCount,
        completedAt: now,
      }).where(eq(busRouteSyncRunsTable.id, runId!));
    });
    result.status = "SUCCESS";
  } catch (error) {
    result.error = error instanceof Error ? error.message : "Bus route sync failed";
    logger.error({ err: error, syncRunId: runId }, "Bus route reference sync failed");
    if (runId) {
      try {
        await db.update(busRouteSyncRunsTable).set({
          status: "FAILED",
          sourceTitle: result.sourceTitle,
          discoveredSheets: result.discoveredSheets,
          skippedSheets: result.skippedSheets,
          sourceRows: result.sourceRows,
          distinctRoutes: result.distinctRoutes,
          addedCount: 0,
          updatedCount: 0,
          unchangedCount: 0,
          inactiveCount: 0,
          error: result.error,
          completedAt: new Date(),
        }).where(eq(busRouteSyncRunsTable.id, runId));
      } catch (historyError) {
        logger.error({ err: historyError, syncRunId: runId }, "Could not record failed bus route sync");
      }
    }
    result.addedCount = 0;
    result.updatedCount = 0;
    result.unchangedCount = 0;
    result.inactiveCount = 0;
  }
  result.completedAt = new Date().toISOString();
  return result;
}