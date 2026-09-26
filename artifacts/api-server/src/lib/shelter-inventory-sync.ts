import { and, eq } from "drizzle-orm";
import {
  db,
  inventoryAssetsTable,
  inventoryMediaUnitsTable,
  inventorySyncChangesTable,
  inventorySyncRunsTable,
} from "@workspace/db";
import { logger } from "./logger";
import {
  readShelterSourceSheets,
  type SheetRow,
  type ShelterSheetName,
} from "./shelter-google-sheets";
import {
  compareShelterMediaUnit,
  parseShelterSourceRow,
  compareShelterRecord,
  type ParsedShelter,
  type ShelterMediaUnitPlan,
} from "./shelter-source-rules";

export type ShelterSyncResult = {
  success: boolean;
  status: "SUCCESS" | "FAILED";
  syncRunId: string | null;
  sourceTitle: string | null;
  sourceRows: number;
  addedCount: number;
  updatedCount: number;
  unchangedCount: number;
  removedCount: number;
  missingCount: number;
  reviewCount: number;
  duplicateCount: number;
  error: string | null;
  startedAt: string;
  completedAt: string;
};

const SOURCE_FAMILY = "BUS_SHELTER";
export { parseShelterSourceRow };
export type { ParsedShelter };

let activeSync: Promise<ShelterSyncResult> | null = null;

export async function syncShelterInventory(trigger: string): Promise<ShelterSyncResult> {
  if (activeSync) return activeSync;
  activeSync = runShelterSync(trigger);
  try {
    return await activeSync;
  } finally {
    activeSync = null;
  }
}

async function runShelterSync(trigger: string): Promise<ShelterSyncResult> {
  const startedAt = new Date();
  const result: ShelterSyncResult = {
    success: false,
    status: "FAILED",
    syncRunId: null,
    sourceTitle: null,
    sourceRows: 0,
    addedCount: 0,
    updatedCount: 0,
    unchangedCount: 0,
    removedCount: 0,
    missingCount: 0,
    reviewCount: 0,
    duplicateCount: 0,
    error: null,
    startedAt: startedAt.toISOString(),
    completedAt: startedAt.toISOString(),
  };
  let runId: string | null = null;
  try {
    const [run] = await db.insert(inventorySyncRunsTable).values({
      sourceFamily: SOURCE_FAMILY,
      status: "RUNNING",
      trigger: trigger.trim() || "manual",
    }).returning({ id: inventorySyncRunsTable.id });
    if (!run) throw new Error("Could not create inventory sync run record");
    runId = run.id;
    result.syncRunId = runId;

    const source = await readShelterSourceSheets();
    result.sourceTitle = source.title;
    const parsed = (Object.entries(source.sheets) as Array<[ShelterSheetName, SheetRow[]]>)
      .flatMap(([sheetName, rows]) => rows.map((row) => parseShelterSourceRow(sheetName, row)))
      .filter((row): row is ParsedShelter => row !== null);
    result.sourceRows = parsed.length;
    const duplicateKeys = new Set<string>();
    const seen = new Set<string>();
    for (const row of parsed) {
      if (seen.has(row.sourceKey)) duplicateKeys.add(row.sourceKey);
      seen.add(row.sourceKey);
    }
    // A repeated shelter number cannot be resolved using location: removed and active
    // rows can share an ID. Quarantine the entire key, never choose one arbitrarily.
    result.duplicateCount = duplicateKeys.size;

    await db.transaction(async (tx) => {
      const previous = await tx.select().from(inventoryAssetsTable).where(and(
        eq(inventoryAssetsTable.sourceFamily, SOURCE_FAMILY),
      ));
      const existingByKey = new Map(previous
        .filter((asset) => asset.sourceKey)
        .map((asset) => [asset.sourceKey!, asset]));
      const sourceKeys = new Set(parsed.map((row) => row.sourceKey));
      const now = new Date();
      for (const sourceKey of duplicateKeys) {
        const collidingRows = parsed.filter((row) => row.sourceKey === sourceKey);
        await tx.insert(inventorySyncChangesTable).values({
          syncRunId: runId!,
          inventoryAssetId: existingByKey.get(sourceKey)?.id ?? null,
          sourceKey,
          changeType: "DUPLICATE_SOURCE_KEY",
          changedFields: {
            sourceRowCount: { before: null, after: collidingRows.length },
            disposition: { before: null, after: "Quarantined: no source row was selected or imported" },
          },
        });
        result.reviewCount += 1;
      }
      for (const row of parsed) {
        if (duplicateKeys.has(row.sourceKey)) continue;
        if (row.values.syncReviewReasons?.length) result.reviewCount += 1;
        const oldAsset = existingByKey.get(row.sourceKey);
        const removed = row.values.sourceLifecycleStatus === "REMOVED";
        const insertValues = {
          ...row.values,
          lastSeenAt: now,
          sourceRecordHash: row.hash,
          removedDetectedAt: removed ? oldAsset?.removedDetectedAt ?? now : null,
        };
        if (!oldAsset) {
          const [created] = await tx.insert(inventoryAssetsTable).values(insertValues).returning();
          if (!created) throw new Error(`Could not add shelter ${row.sourceKey}`);
          const mediaChanges = await synchronizeMediaUnits(tx, created.id, row, now, removed);
          result.addedCount += 1;
          if (removed) result.removedCount += 1;
          await tx.insert(inventorySyncChangesTable).values({
            syncRunId: runId!,
            inventoryAssetId: created.id,
            sourceKey: row.sourceKey,
            changeType: removed ? "REMOVED" : "ADDED",
            changedFields: {
              ...Object.fromEntries(Object.entries(row.values).map(([field, value]) => [
              field, { before: null, after: value ?? null },
              ])),
              ...mediaChanges,
            },
          });
        } else {
          const mediaChanges = await synchronizeMediaUnits(tx, oldAsset.id, row, now, removed);
          const changedFields = {
            ...compareShelterRecord(
            oldAsset as unknown as Record<string, unknown>,
            insertValues as unknown as Record<string, unknown>,
            ),
            ...mediaChanges,
          };
          if (Object.keys(changedFields).length === 0 && oldAsset.sourceRecordHash !== row.hash) {
            changedFields.sourceRecordHash = {
              before: oldAsset.sourceRecordHash,
              after: row.hash,
            };
          }
          const recordChanged = Object.keys(changedFields).length > 0 ||
            oldAsset.sourceRecordHash !== row.hash;
          if (!recordChanged) {
            result.unchangedCount += 1;
          } else {
            await tx.update(inventoryAssetsTable).set(insertValues).where(eq(inventoryAssetsTable.id, oldAsset.id));
            result.updatedCount += 1;
            if (removed && oldAsset.sourceLifecycleStatus !== "REMOVED") result.removedCount += 1;
            await tx.insert(inventorySyncChangesTable).values({
              syncRunId: runId!,
              inventoryAssetId: oldAsset.id,
              sourceKey: row.sourceKey,
              changeType: removed && oldAsset.sourceLifecycleStatus !== "REMOVED" ? "REMOVED" : "UPDATED",
              changedFields,
            });
          }
        }
      }

      for (const asset of previous) {
        if (!asset.sourceKey || sourceKeys.has(asset.sourceKey) || asset.sourceLifecycleStatus === "REMOVED") continue;
        if (asset.sourceFamily !== SOURCE_FAMILY) continue;
        const reasons = [...new Set([...asset.syncReviewReasons, "MISSING_FROM_SOURCE"])];
        const missingPatch = {
          sourceLifecycleStatus: "MISSING_FROM_SOURCE",
          isActive: true,
          syncReviewReasons: reasons,
          lastSeenAt: asset.lastSeenAt,
        };
        const changes = compareShelterRecord(
          asset as unknown as Record<string, unknown>,
          missingPatch as unknown as Record<string, unknown>,
        );
        if (!Object.keys(changes).length) continue;
        await tx.update(inventoryAssetsTable).set(missingPatch).where(eq(inventoryAssetsTable.id, asset.id));
        result.missingCount += 1;
        result.reviewCount += 1;
        await tx.insert(inventorySyncChangesTable).values({
          syncRunId: runId!,
          inventoryAssetId: asset.id,
          sourceKey: asset.sourceKey,
          changeType: "MISSING_FROM_SOURCE",
          changedFields: changes,
        });
      }
      await tx.update(inventorySyncRunsTable).set({
        status: "SUCCESS",
        sourceTitle: source.title,
        sourceRows: result.sourceRows,
        addedCount: result.addedCount,
        updatedCount: result.updatedCount,
        unchangedCount: result.unchangedCount,
        removedCount: result.removedCount,
        missingCount: result.missingCount,
        reviewCount: result.reviewCount,
        duplicateCount: result.duplicateCount,
        completedAt: now,
      }).where(eq(inventorySyncRunsTable.id, runId!));
    });
    result.success = true;
    result.status = "SUCCESS";
  } catch (error) {
    result.error = error instanceof Error ? error.message : "Shelter inventory sync failed";
    logger.error({ err: error, syncRunId: runId }, "Shelter inventory sync failed");
    if (runId) {
      try {
        await db.update(inventorySyncRunsTable).set({
          status: "FAILED",
          sourceTitle: result.sourceTitle,
          sourceRows: result.sourceRows,
          addedCount: 0,
          updatedCount: 0,
          unchangedCount: 0,
          removedCount: 0,
          missingCount: 0,
          reviewCount: 0,
          duplicateCount: result.duplicateCount,
          error: result.error,
          completedAt: new Date(),
        }).where(eq(inventorySyncRunsTable.id, runId));
      } catch (historyError) {
        logger.error({ err: historyError, syncRunId: runId }, "Could not record failed shelter sync");
      }
    }
    result.addedCount = 0;
    result.updatedCount = 0;
    result.unchangedCount = 0;
    result.removedCount = 0;
    result.missingCount = 0;
    result.reviewCount = 0;
  }
  result.completedAt = new Date().toISOString();
  return result;
}

async function synchronizeMediaUnits(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  parentId: string,
  row: ParsedShelter,
  now: Date,
  shelterRemoved: boolean,
): Promise<Record<string, { before: unknown; after: unknown }>> {
  const assetId = parentId;
  const existingUnits = await tx.select().from(inventoryMediaUnitsTable)
    .where(eq(inventoryMediaUnitsTable.parentInventoryAssetId, assetId));
  const planByType = new Map<string, ShelterMediaUnitPlan>(row.mediaUnits.map((unit) => [unit.unitType, unit]));
  const changes: Record<string, { before: unknown; after: unknown }> = {};
  for (const plan of row.mediaUnits) {
    const current = existingUnits.find((unit) => unit.unitType === plan.unitType);
    const values = {
      format: plan.format,
      sourceType: plan.sourceType,
      availabilityStatus: "UNKNOWN",
      lifecycleStatus: shelterRemoved ? "REMOVED" : plan.lifecycleStatus,
      currentClient: plan.currentClient,
      campaignStart: plan.campaignStart,
      campaignEnd: plan.campaignEnd,
      internalNotes: shelterRemoved ? "Shelter Removed in source" : plan.internalNotes,
    };
    const unitChangedFields = compareShelterMediaUnit(
      plan.unitType,
      current as unknown as Record<string, unknown> | null,
      values,
    );
    if (!current) {
      const inserted = {
        parentInventoryAssetId: assetId,
        unitType: plan.unitType,
        ...values,
      };
      await tx.insert(inventoryMediaUnitsTable).values(inserted);
      for (const [field, value] of Object.entries(values)) {
        changes[`mediaUnits.${plan.unitType}.${field}`] = { before: null, after: value ?? null };
      }
    } else if (Object.keys(unitChangedFields).length) {
      await tx.update(inventoryMediaUnitsTable).set({ ...values, updatedAt: now })
        .where(eq(inventoryMediaUnitsTable.id, current.id));
      Object.assign(changes, unitChangedFields);
    }
  }
  for (const current of existingUnits) {
    if (planByType.has(current.unitType)) continue;
    const internalNotes = shelterRemoved
      ? "Shelter Removed in source"
      : "No longer listed by the source media category";
    const unitChangedFields: Record<string, { before: unknown; after: unknown }> = {};
    if (current.lifecycleStatus !== "REMOVED") {
      unitChangedFields[`mediaUnits.${current.unitType}.lifecycleStatus`] = {
        before: current.lifecycleStatus,
        after: "REMOVED",
      };
    }
    if (current.internalNotes !== internalNotes) {
      unitChangedFields[`mediaUnits.${current.unitType}.internalNotes`] = {
        before: current.internalNotes,
        after: internalNotes,
      };
    }
    if (!Object.keys(unitChangedFields).length) continue;
    await tx.update(inventoryMediaUnitsTable).set({
      lifecycleStatus: "REMOVED",
      internalNotes,
      updatedAt: now,
    }).where(eq(inventoryMediaUnitsTable.id, current.id));
    Object.assign(changes, unitChangedFields);
  }
  return changes;
}