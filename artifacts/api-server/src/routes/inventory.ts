import { Router, type IRouter } from "express";
import { and, arrayOverlaps, asc, count, desc, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import {
  CommitInventoryImportBody,
  CommitInventoryImportResponse,
  FindNearbyInventoryAssetsQueryParams,
  FindNearbyInventoryAssetsResponse,
  GetInventoryAssetParams,
  GetInventoryAssetResponse,
  GetInventoryQualitySummaryResponse,
  ListInventoryAssetsQueryParams,
  ListInventoryAssetsResponse,
  ListInventoryImportsResponse,
  ListProjectInventorySelectionsParams,
  ListProjectInventorySelectionsResponse,
  PreviewInventoryImportBody,
  PreviewInventoryImportResponse,
  RemoveProjectInventorySelectionParams,
  SetProjectInventorySelectionBody,
  SetProjectInventorySelectionParams,
  SetProjectInventorySelectionResponse,
} from "@workspace/api-zod";
import {
  db,
  inventoryAssetsTable,
  inventoryImportBatchesTable,
  inventoryMediaUnitsTable,
  pitchProjectsTable,
  projectInventorySelectionsTable,
} from "@workspace/db";
import {
  distanceMeters,
  INVENTORY_DISTANCE_THRESHOLDS,
  INVENTORY_IMPORT_FIELDS,
  coordinateSearchBounds,
  mappedRawImportData,
  parseInventoryImportRow,
  serializeInventoryAsset,
} from "../lib/inventory";

const router: IRouter = Router();

type ImportRequest = {
  fileName?: string | null;
  mapping: Record<string, string>;
  rows: Array<Record<string, unknown>>;
};

function validateImportRows(input: ImportRequest) {
  const mappingErrors: string[] = [];
  for (const [field, header] of Object.entries(input.mapping)) {
    if (!INVENTORY_IMPORT_FIELDS.has(field)) mappingErrors.push(`Unknown mapped field: ${field}`);
    if (!header.trim()) mappingErrors.push(`Mapping for ${field} must name a column`);
  }
  if (!input.mapping.assetCode || !input.mapping.assetType) {
    mappingErrors.push("Mappings for assetCode and assetType are required");
  }

  const parsedRows = input.rows.map((row, rowIndex) => {
    const parsed = parseInventoryImportRow(row, input.mapping);
    if (Object.keys(row).length > 100) parsed.issues.push("A row may contain at most 100 columns");
    if (Object.keys(row).some((key) => key.length > 200)) parsed.issues.push("Column headers may not exceed 200 characters");
    for (const header of Object.values(input.mapping)) {
      if (!Object.hasOwn(row, header)) parsed.issues.push(`Mapped column "${header}" is missing`);
    }
    return { rowIndex, ...parsed, existingAssetId: null as string | null };
  });
  const duplicateFileCodes = new Set<string>();
  const codeIndexes = new Map<string, number[]>();
  for (const row of parsedRows) {
    if (row.assetCode) {
      const key = row.assetCode.toLocaleLowerCase();
      codeIndexes.set(key, [...(codeIndexes.get(key) ?? []), row.rowIndex]);
    }
  }
  for (const indexes of codeIndexes.values()) {
    if (indexes.length > 1) for (const index of indexes) duplicateFileCodes.add(String(index));
  }
  for (const row of parsedRows) {
    if (duplicateFileCodes.has(String(row.rowIndex))) {
      row.issues.push("Asset ID is duplicated within this file");
    }
  }

  return { mappingErrors, parsedRows, duplicateFileCodes };
}

function makePreview(rows: ReturnType<typeof validateImportRows>["parsedRows"]) {
  return {
    rowCount: rows.length,
    addCount: rows.filter((row) => !row.issues.length && !row.existingAssetId).length,
    updateCount: rows.filter((row) => !row.issues.length && !!row.existingAssetId).length,
    invalidCount: rows.filter((row) => row.issues.length > 0).length,
    duplicateCount: rows.filter((row) => row.issues.some((issue) => issue.includes("duplicated"))).length,
    confirmable: true,
    rows: rows.map((row) => ({
      rowIndex: row.rowIndex,
      assetCode: row.assetCode,
      suggestedAction: (row.issues.length ? "skip" : row.existingAssetId ? "update" : "add") as "skip" | "update" | "add",
      requiresChoice: true,
      existingAssetId: row.existingAssetId,
      issues: row.issues,
    })),
  };
}

async function findExistingAssets(assetCodes: string[]) {
  if (!assetCodes.length) return new Map<string, string>();
  const existing = await db.select({
    id: inventoryAssetsTable.id,
    assetCode: inventoryAssetsTable.assetCode,
  }).from(inventoryAssetsTable).where(inArray(
    sql<string>`lower(${inventoryAssetsTable.assetCode})`,
    assetCodes.map((code) => code.toLocaleLowerCase()),
  ));
  return new Map(existing.map((asset) => [asset.assetCode.toLocaleLowerCase(), asset.id]));
}

function withQuality<T extends typeof inventoryAssetsTable.$inferSelect>(asset: T) {
  return serializeInventoryAsset(asset);
}

async function mediaByAssetIds(ids: string[]) {
  const units = ids.length
    ? await db.select().from(inventoryMediaUnitsTable).where(inArray(inventoryMediaUnitsTable.parentInventoryAssetId, ids))
    : [];
  const grouped = new Map<string, typeof units>();
  for (const unit of units) grouped.set(unit.parentInventoryAssetId, [...(grouped.get(unit.parentInventoryAssetId) ?? []), unit]);
  return grouped;
}

router.get("/inventory/assets", async (req, res): Promise<void> => {
  const query = ListInventoryAssetsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const { search, assetType, area, road, availability, route, displayTechnology, client, bookingStatus, limit, offset,
    sourceFamily, shelterConfiguration, sourceMediaType, mediaUnit, powerStatus, accountability,
    tentativeClient, lifecycleStatus, coordinateState, includeInactive } = query.data;
  const filters = [];
  if (!includeInactive) filters.push(eq(inventoryAssetsTable.isActive, true));
  if (sourceFamily) filters.push(eq(inventoryAssetsTable.sourceFamily, sourceFamily));
  if (shelterConfiguration) filters.push(eq(inventoryAssetsTable.shelterConfiguration, shelterConfiguration));
  if (sourceMediaType) filters.push(ilike(inventoryAssetsTable.sourceMediaType, sourceMediaType));
  if (powerStatus) filters.push(ilike(inventoryAssetsTable.powerStatus, `%${powerStatus}%`));
  if (accountability) filters.push(ilike(inventoryAssetsTable.accountability, `%${accountability}%`));
  if (tentativeClient) filters.push(ilike(inventoryAssetsTable.tentativeClient, `%${tentativeClient}%`));
  if (lifecycleStatus) filters.push(eq(inventoryAssetsTable.sourceLifecycleStatus, lifecycleStatus));
  if (coordinateState === "VALID") filters.push(and(sql`${inventoryAssetsTable.latitude} IS NOT NULL`, sql`${inventoryAssetsTable.longitude} IS NOT NULL`)!);
  if (coordinateState === "MISSING_OR_INVALID_COORDINATES") filters.push(or(sql`${inventoryAssetsTable.latitude} IS NULL`, sql`${inventoryAssetsTable.longitude} IS NULL`)!);
  if (mediaUnit) {
    const [format, unitType] = mediaUnit.split("_");
    filters.push(inArray(inventoryAssetsTable.id,
      db.select({ id: inventoryMediaUnitsTable.parentInventoryAssetId }).from(inventoryMediaUnitsTable)
        .where(and(eq(inventoryMediaUnitsTable.unitType, unitType === "TOP" ? "TOP_PANEL" : "MUPI"),
          eq(inventoryMediaUnitsTable.format, format), eq(inventoryMediaUnitsTable.lifecycleStatus, "ACTIVE")))));
  }
  if (assetType) filters.push(ilike(inventoryAssetsTable.assetType, `%${assetType}%`));
  if (area) filters.push(or(
    ilike(inventoryAssetsTable.area, `%${area}%`),
    ilike(inventoryAssetsTable.areaNormalized, `%${area}%`),
  )!);
  if (road) filters.push(or(
    ilike(inventoryAssetsTable.road, `%${road}%`),
    ilike(inventoryAssetsTable.roadNormalized, `%${road}%`),
  )!);
  if (availability) filters.push(ilike(inventoryAssetsTable.availability, `%${availability}%`));
  if (route) filters.push(arrayOverlaps(inventoryAssetsTable.routes, [route]));
  if (displayTechnology) filters.push(eq(inventoryAssetsTable.displayTechnology, displayTechnology));
  if (client) filters.push(or(ilike(inventoryAssetsTable.client, `%${client}%`), ilike(inventoryAssetsTable.currentClientRaw, `%${client}%`))!);
  if (bookingStatus) filters.push(ilike(inventoryAssetsTable.bookingStatus, `%${bookingStatus}%`));
  if (search) {
    const pattern = `%${search}%`;
    filters.push(or(
      ilike(inventoryAssetsTable.assetCode, pattern),
      ilike(inventoryAssetsTable.assetName, pattern),
      ilike(inventoryAssetsTable.area, pattern),
      ilike(inventoryAssetsTable.areaNormalized, pattern),
      ilike(inventoryAssetsTable.road, pattern),
      ilike(inventoryAssetsTable.roadNormalized, pattern),
      ilike(inventoryAssetsTable.client, pattern),
      ilike(inventoryAssetsTable.currentClientRaw, pattern),
      ilike(inventoryAssetsTable.shelterNumber, pattern),
      sql`array_to_string(${inventoryAssetsTable.routes}, ' ') ILIKE ${pattern}`,
      sql`array_to_string(${inventoryAssetsTable.nearbyPois}, ' ') ILIKE ${pattern}`,
    )!);
  }
  const where = filters.length ? and(...filters) : undefined;
  const [totalResult] = await db.select({ total: count() }).from(inventoryAssetsTable).where(where);
  const assets = await db.select().from(inventoryAssetsTable).where(where)
    .orderBy(asc(inventoryAssetsTable.assetCode)).limit(limit).offset(offset);
  const units = await mediaByAssetIds(assets.map((asset) => asset.id));
  res.json(ListInventoryAssetsResponse.parse({
    items: assets.map((asset) => ({ ...withQuality(asset), mediaUnits: units.get(asset.id) ?? [] })),
    total: Number(totalResult?.total ?? 0),
    limit,
    offset,
  }));
});

router.get("/inventory/assets/:id", async (req, res): Promise<void> => {
  const params = GetInventoryAssetParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [asset] = await db.select().from(inventoryAssetsTable)
    .where(eq(inventoryAssetsTable.id, params.data.id));
  if (!asset) {
    res.status(404).json({ error: "Inventory asset not found" });
    return;
  }
  const units = await mediaByAssetIds([asset.id]);
  res.json(GetInventoryAssetResponse.parse({ ...withQuality(asset), mediaUnits: units.get(asset.id) ?? [] }));
});

router.post("/inventory/imports/preview", async (req, res): Promise<void> => {
  const body = PreviewInventoryImportBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const validation = validateImportRows(body.data);
  if (validation.mappingErrors.length) {
    res.status(400).json({ error: validation.mappingErrors.join("; ") });
    return;
  }
  const existing = await findExistingAssets(validation.parsedRows
    .map((row) => row.assetCode).filter((code): code is string => !!code));
  for (const row of validation.parsedRows) {
    row.existingAssetId = row.assetCode ? existing.get(row.assetCode.toLocaleLowerCase()) ?? null : null;
  }
  res.json(PreviewInventoryImportResponse.parse(makePreview(validation.parsedRows)));
});

router.post("/inventory/imports", async (req, res): Promise<void> => {
  const body = CommitInventoryImportBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const validation = validateImportRows(body.data);
  if (validation.mappingErrors.length) {
    res.status(400).json({ error: validation.mappingErrors.join("; ") });
    return;
  }
  const decisions = new Map<number, "add" | "update" | "skip">();
  for (const decision of body.data.decisions) {
    if (decisions.has(decision.rowIndex)) {
      res.status(400).json({ error: `Duplicate decision for row ${decision.rowIndex}` });
      return;
    }
    decisions.set(decision.rowIndex, decision.action);
  }
  if (decisions.size !== body.data.rows.length ||
      body.data.rows.some((_row, index) => !decisions.has(index))) {
    res.status(400).json({ error: "Every row requires an explicit add, update, or skip decision" });
    return;
  }

  try {
    const batch = await db.transaction(async (tx) => {
      const assetCodes = validation.parsedRows
        .map((row) => row.assetCode).filter((code): code is string => !!code);
      const currentAssets = assetCodes.length
        ? await tx.select({
          id: inventoryAssetsTable.id,
          assetCode: inventoryAssetsTable.assetCode,
          sourceFamily: inventoryAssetsTable.sourceFamily,
        }).from(inventoryAssetsTable).where(inArray(
          sql<string>`lower(${inventoryAssetsTable.assetCode})`,
          assetCodes.map((code) => code.toLocaleLowerCase()),
        ))
        : [];
      const existing = new Map(currentAssets.map((asset) => [asset.assetCode.toLocaleLowerCase(), asset.id]));
      for (const row of validation.parsedRows) {
        row.existingAssetId = row.assetCode ? existing.get(row.assetCode.toLocaleLowerCase()) ?? null : null;
      }

      const additions = new Map<string, number>();
      for (const row of validation.parsedRows) {
        const decision = decisions.get(row.rowIndex)!;
        const hasIssues = row.issues.length > 0;
        if (hasIssues && decision !== "skip") {
          throw new Error(`Row ${row.rowIndex + 1} has validation errors and can only be skipped`);
        }
        if (!hasIssues && row.assetCode) {
          const exists = existing.has(row.assetCode.toLocaleLowerCase());
          if (decision === "update" && currentAssets.some((asset) =>
            asset.assetCode.toLocaleLowerCase() === row.assetCode!.toLocaleLowerCase() &&
            asset.sourceFamily === "BUS_SHELTER")) {
            throw new Error("A synced shelter cannot be overwritten by manual import; edit the source Google Sheet");
          }
          if ((decision === "add" && exists) || (decision === "update" && !exists)) {
            throw new Error("Inventory changed since preview; preview again");
          }
          additions.set(row.assetCode.toLocaleLowerCase(), (additions.get(row.assetCode.toLocaleLowerCase()) ?? 0) + 1);
        }
      }
      if ([...additions.values()].some((occurrences) => occurrences > 1)) {
        throw new Error("Asset ID is duplicated within this file");
      }

      const addCount = validation.parsedRows.filter((row) => decisions.get(row.rowIndex) === "add").length;
      const updateCount = validation.parsedRows.filter((row) => decisions.get(row.rowIndex) === "update").length;
      const skippedCount = validation.parsedRows.length - addCount - updateCount;
      const [createdBatch] = await tx.insert(inventoryImportBatchesTable).values({
        fileName: body.data.fileName ?? null,
        mapping: body.data.mapping,
        rowCount: body.data.rows.length,
        addedCount: addCount,
        updatedCount: updateCount,
        skippedCount,
      }).returning();
      if (!createdBatch) throw new Error("Could not create import history record");

      for (const row of validation.parsedRows) {
        const action = decisions.get(row.rowIndex)!;
        if (action === "skip") continue;
        if (!row.assetCode) throw new Error(`Row ${row.rowIndex + 1} is missing an Asset ID`);
        const values = {
          ...row.values,
          assetCode: row.assetCode,
          sourceFamily: row.values.assetType === "Bus" ? "BUS" : "MANUAL",
          sourceImportBatchId: createdBatch.id,
          rawImportData: mappedRawImportData(body.data.rows[row.rowIndex], body.data.mapping),
        } as typeof inventoryAssetsTable.$inferInsert;
        if (action === "add") {
          await tx.insert(inventoryAssetsTable).values(values);
        } else {
          const existingId = existing.get(row.assetCode.toLocaleLowerCase());
          if (!existingId) throw new Error("Inventory changed since preview; preview again");
          const { assetCode: _assetCode, sourceFamily: _sourceFamily, ...updateValues } = values;
          await tx.update(inventoryAssetsTable).set(updateValues)
            .where(eq(inventoryAssetsTable.id, existingId));
        }
      }
      return createdBatch;
    });
    res.status(201).json(CommitInventoryImportResponse.parse(batch));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Inventory import failed";
    const databaseCode = error && typeof error === "object" && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
    res.status(message.includes("changed since preview") || databaseCode === "23505" ? 409 : 400)
      .json({ error: message.includes("changed since preview") || databaseCode === "23505"
        ? "Inventory changed during import; preview again"
        : message });
  }
});

router.get("/inventory/imports", async (_req, res): Promise<void> => {
  const batches = await db.select().from(inventoryImportBatchesTable)
    .orderBy(desc(inventoryImportBatchesTable.createdAt)).limit(200);
  res.json(ListInventoryImportsResponse.parse(batches));
});

router.get("/inventory/quality-summary", async (_req, res): Promise<void> => {
  const missingCoordinates = sql`(${inventoryAssetsTable.latitude} IS NULL OR ${inventoryAssetsTable.longitude} IS NULL)`;
  const missingPhoto = sql`(${inventoryAssetsTable.photoPath} IS NULL OR trim(${inventoryAssetsTable.photoPath}) = '')`;
  const missingAvailability = sql`(${inventoryAssetsTable.availability} IS NULL OR trim(${inventoryAssetsTable.availability}) = '')`;
  const needsReview = sql`((${inventoryAssetsTable.latitude} IS NULL) <> (${inventoryAssetsTable.longitude} IS NULL)) OR (${inventoryAssetsTable.startDate} IS NOT NULL AND ${inventoryAssetsTable.endDate} IS NOT NULL AND ${inventoryAssetsTable.endDate} < ${inventoryAssetsTable.startDate})`;
  const [counts] = await db.select({
    totalAssets: sql<number>`count(*)::int`,
    complete: sql<number>`count(*) FILTER (WHERE NOT ${missingCoordinates} AND NOT ${missingPhoto} AND NOT ${missingAvailability} AND NOT ${needsReview})::int`,
    missingCoordinates: sql<number>`count(*) FILTER (WHERE ${missingCoordinates})::int`,
    missingPhoto: sql<number>`count(*) FILTER (WHERE ${missingPhoto})::int`,
    missingAvailability: sql<number>`count(*) FILTER (WHERE ${missingAvailability})::int`,
    needsReview: sql<number>`count(*) FILTER (WHERE ${needsReview})::int`,
  }).from(inventoryAssetsTable).where(eq(inventoryAssetsTable.isActive, true));
  const summary = {
    totalAssets: Number(counts?.totalAssets ?? 0),
    complete: Number(counts?.complete ?? 0),
    missingCoordinates: Number(counts?.missingCoordinates ?? 0),
    missingPhoto: Number(counts?.missingPhoto ?? 0),
    missingAvailability: Number(counts?.missingAvailability ?? 0),
    needsReview: Number(counts?.needsReview ?? 0),
  };
  res.json(GetInventoryQualitySummaryResponse.parse(summary));
});

router.get("/inventory/nearby", async (req, res): Promise<void> => {
  const params = FindNearbyInventoryAssetsQueryParams.safeParse({
    ...req.query,
    thresholdMeters: typeof req.query.thresholdMeters === "string"
      ? Number(req.query.thresholdMeters)
      : req.query.thresholdMeters,
  });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  if (!INVENTORY_DISTANCE_THRESHOLDS.includes(params.data.thresholdMeters as typeof INVENTORY_DISTANCE_THRESHOLDS[number])) {
    res.status(400).json({ error: "Unsupported distance threshold" });
    return;
  }
  const bounds = coordinateSearchBounds(
    params.data.latitude,
    params.data.longitude,
    params.data.thresholdMeters,
  );
  const longitudeCondition = bounds.west === undefined || bounds.east === undefined
    ? undefined
    : bounds.west < -180
      ? or(
        sql`${inventoryAssetsTable.longitude} >= ${bounds.west + 360}`,
        sql`${inventoryAssetsTable.longitude} <= ${bounds.east}`,
      )
      : bounds.east > 180
        ? or(
          sql`${inventoryAssetsTable.longitude} >= ${bounds.west}`,
          sql`${inventoryAssetsTable.longitude} <= ${bounds.east - 360}`,
        )
        : and(
          sql`${inventoryAssetsTable.longitude} >= ${bounds.west}`,
          sql`${inventoryAssetsTable.longitude} <= ${bounds.east}`,
        );
  const candidates = await db.select().from(inventoryAssetsTable)
    .where(and(
      eq(inventoryAssetsTable.isActive, true),
      sql`${inventoryAssetsTable.latitude} IS NOT NULL`,
      sql`${inventoryAssetsTable.longitude} IS NOT NULL`,
      sql`${inventoryAssetsTable.latitude} BETWEEN ${bounds.south} AND ${bounds.north}`,
      longitudeCondition,
    ));
  const nearby = candidates.map((asset) => ({
    asset: withQuality(asset),
    distanceMeters: distanceMeters(
      params.data.latitude,
      params.data.longitude,
      asset.latitude!,
      asset.longitude!,
    ),
  })).filter((entry) => entry.distanceMeters <= params.data.thresholdMeters)
    .sort((a, b) => a.distanceMeters - b.distanceMeters)
    .slice(0, params.data.limit);
  res.json(FindNearbyInventoryAssetsResponse.parse(nearby));
});

router.get("/projects/:projectId/inventory", async (req, res): Promise<void> => {
  const params = ListProjectInventorySelectionsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [project] = await db.select({ id: pitchProjectsTable.id }).from(pitchProjectsTable)
    .where(eq(pitchProjectsTable.id, params.data.projectId));
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const selectionRows = await db.select({
    selection: projectInventorySelectionsTable,
    asset: inventoryAssetsTable,
  }).from(projectInventorySelectionsTable)
    .innerJoin(inventoryAssetsTable, eq(projectInventorySelectionsTable.inventoryAssetId, inventoryAssetsTable.id))
    .where(eq(projectInventorySelectionsTable.projectId, params.data.projectId))
    .orderBy(desc(projectInventorySelectionsTable.updatedAt))
    .limit(500);
  const units = await mediaByAssetIds([...new Set(selectionRows.map(({ asset }) => asset.id))]);
  res.json(ListProjectInventorySelectionsResponse.parse(selectionRows.map(({ selection, asset }) => ({
    ...selection,
    asset: { ...withQuality(asset), mediaUnits: units.get(asset.id) ?? [] },
  }))));
});

router.put("/projects/:projectId/inventory/:assetId", async (req, res): Promise<void> => {
  const params = SetProjectInventorySelectionParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const body = SetProjectInventorySelectionBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const [project] = await db.select({ id: pitchProjectsTable.id }).from(pitchProjectsTable)
    .where(eq(pitchProjectsTable.id, params.data.projectId));
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const [asset] = await db.select({ id: inventoryAssetsTable.id }).from(inventoryAssetsTable)
    .where(and(eq(inventoryAssetsTable.id, params.data.assetId), eq(inventoryAssetsTable.isActive, true)));
  if (!asset) {
    res.status(404).json({ error: "Inventory asset not found" });
    return;
  }
  const [selection] = await db.insert(projectInventorySelectionsTable).values({
    projectId: params.data.projectId,
    inventoryAssetId: params.data.assetId,
    status: body.data.status,
    note: body.data.note ?? null,
  }).onConflictDoUpdate({
    target: [projectInventorySelectionsTable.projectId, projectInventorySelectionsTable.inventoryAssetId],
    targetWhere: sql`${projectInventorySelectionsTable.inventoryMediaUnitId} IS NULL`,
    set: { status: body.data.status, note: body.data.note ?? null, updatedAt: new Date() },
  }).returning();
  if (!selection) {
    res.status(500).json({ error: "Could not save project inventory selection" });
    return;
  }
  const [selectedAsset] = await db.select().from(inventoryAssetsTable)
    .where(eq(inventoryAssetsTable.id, selection.inventoryAssetId));
  res.json(SetProjectInventorySelectionResponse.parse({
    ...selection,
    asset: { ...withQuality(selectedAsset!), mediaUnits: (await mediaByAssetIds([selectedAsset!.id])).get(selectedAsset!.id) ?? [] },
  }));
});

router.put("/projects/:projectId/inventory/:assetId/units/:unitId", async (req, res): Promise<void> => {
  const params = SetProjectInventorySelectionParams.safeParse(req.params);
  const body = SetProjectInventorySelectionBody.safeParse(req.body);
  const unitId = req.params.unitId;
  if (!params.success || !body.success || typeof unitId !== "string" || !/^[0-9a-f-]{36}$/i.test(unitId)) {
    res.status(400).json({ error: "Invalid project, asset, unit or selection" });
    return;
  }
  const [project] = await db.select({ id: pitchProjectsTable.id }).from(pitchProjectsTable).where(eq(pitchProjectsTable.id, params.data.projectId));
  const [asset] = await db.select().from(inventoryAssetsTable).where(and(eq(inventoryAssetsTable.id, params.data.assetId), eq(inventoryAssetsTable.isActive, true)));
  const [unit] = await db.select().from(inventoryMediaUnitsTable).where(and(
    eq(inventoryMediaUnitsTable.id, unitId), eq(inventoryMediaUnitsTable.parentInventoryAssetId, params.data.assetId),
    eq(inventoryMediaUnitsTable.lifecycleStatus, "ACTIVE"),
  ));
  if (!project || !asset || !unit) {
    res.status(404).json({ error: "Project or active media unit not found" });
    return;
  }
  const [selection] = await db.insert(projectInventorySelectionsTable).values({
    projectId: params.data.projectId, inventoryAssetId: asset.id, inventoryMediaUnitId: unit.id,
    status: body.data.status, note: body.data.note ?? null,
  }).onConflictDoUpdate({
    target: [projectInventorySelectionsTable.projectId, projectInventorySelectionsTable.inventoryMediaUnitId],
    set: { status: body.data.status, note: body.data.note ?? null, updatedAt: new Date() },
  }).returning();
  const units = await mediaByAssetIds([asset.id]);
  res.json(SetProjectInventorySelectionResponse.parse({
    ...selection, asset: { ...withQuality(asset), mediaUnits: units.get(asset.id) ?? [] },
  }));
});

router.delete("/projects/:projectId/inventory/:assetId/units/:unitId", async (req, res): Promise<void> => {
  const params = SetProjectInventorySelectionParams.safeParse(req.params);
  const unitId = req.params.unitId;
  if (!params.success || typeof unitId !== "string" || !/^[0-9a-f-]{36}$/i.test(unitId)) {
    res.status(400).json({ error: "Invalid project, asset or unit" });
    return;
  }
  const [deleted] = await db.delete(projectInventorySelectionsTable).where(and(
    eq(projectInventorySelectionsTable.projectId, params.data.projectId),
    eq(projectInventorySelectionsTable.inventoryAssetId, params.data.assetId),
    eq(projectInventorySelectionsTable.inventoryMediaUnitId, unitId),
  )).returning({ id: projectInventorySelectionsTable.id });
  if (!deleted) {
    res.status(404).json({ error: "Unit selection not found" });
    return;
  }
  res.sendStatus(204);
});

router.delete("/projects/:projectId/inventory/:assetId", async (req, res): Promise<void> => {
  const params = RemoveProjectInventorySelectionParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [deleted] = await db.delete(projectInventorySelectionsTable).where(and(
    eq(projectInventorySelectionsTable.projectId, params.data.projectId),
    eq(projectInventorySelectionsTable.inventoryAssetId, params.data.assetId),
    isNull(projectInventorySelectionsTable.inventoryMediaUnitId),
  )).returning({ id: projectInventorySelectionsTable.id });
  if (!deleted) {
    res.status(404).json({ error: "Project inventory selection not found" });
    return;
  }
  res.sendStatus(204);
});

export default router;