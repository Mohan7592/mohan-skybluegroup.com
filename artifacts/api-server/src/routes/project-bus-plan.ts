import { Router, type IRouter, type Request, type Response } from "express";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  AddProjectBusRouteBody,
  AddProjectBusRouteParams,
  AddProjectBusRouteResponse,
  GetProjectBusPlanParams,
  GetProjectBusPlanResponse,
  GetProjectMediaPlanParams,
  GetProjectMediaPlanResponse,
  RemoveProjectBusRouteParams,
  UpdateProjectBusRouteBody,
  UpdateProjectBusRouteParams,
  UpdateProjectBusRouteResponse,
} from "@workspace/api-zod";
import {
  db,
  inventoryAssetsTable,
  inventoryMediaUnitsTable,
  busRouteSourceRowsTable,
  busRoutesTable,
  locationRouteRecommendationsTable,
  pitchProjectsTable,
  projectBusRouteSelectionsTable,
  projectLocationStrategiesTable,
  projectInventorySelectionsTable,
  passengerRouteMetricsTable,
} from "@workspace/db";
import {
  addProjectBusRoute,
  BusPlanServiceError,
  getProjectBusPlan,
  removeProjectBusRoute,
  updateProjectBusRoute,
} from "../lib/bus-plan-service";
import {
  campaignGeographyStatusFromEvidence,
  isBusShelterSourceFamily,
  partitionShelterSelections,
} from "../lib/project-media-plan";
import { isShelterInCampaignGeography } from "../lib/location-market-scope";
import type { CampaignGeographyStatus } from "../lib/location-market-scope";
import { recommendNetworkRoutes } from "../lib/network-recommendations";
import {
  analyzePassengerRouteFamilies,
  analyzePassengerRouteSeries,
} from "../lib/passenger-metrics-analysis";

const router: IRouter = Router();

type NetworkProject = {
  id: string;
  geography: "DUBAI" | "ABU_DHABI" | "UAE" | "CUSTOM";
  campaignAreas: string[];
  targetQuantity: number | null;
  objective: string | null;
};

async function buildProjectNetworkRecommendations(project: NetworkProject, targetBuses: number) {
  const [strategy] = await db.select({
    status: projectLocationStrategiesTable.status,
    targetAreas: projectLocationStrategiesTable.targetAreas,
    targetRoads: projectLocationStrategiesTable.targetRoads,
  }).from(projectLocationStrategiesTable)
    .where(eq(projectLocationStrategiesTable.projectId, project.id)).limit(1);
  const rejectedSelections = await db.select({
    sourceVariantId: projectBusRouteSelectionsTable.sourceVariantId,
  }).from(projectBusRouteSelectionsTable).where(and(
    eq(projectBusRouteSelectionsTable.projectId, project.id),
    eq(projectBusRouteSelectionsTable.status, "REJECTED"),
  ));
  const rejectedRecommendations = await db.select({
    sourceVariantId: locationRouteRecommendationsTable.sourceVariantId,
  }).from(locationRouteRecommendationsTable).where(and(
    eq(locationRouteRecommendationsTable.projectId, project.id),
    eq(locationRouteRecommendationsTable.decision, "REJECTED"),
  ));
  const rejectedVariantIds = new Set([
    ...rejectedSelections.map(({ sourceVariantId }) => sourceVariantId),
    ...rejectedRecommendations.map(({ sourceVariantId }) => sourceVariantId),
  ]);
  const routes = await db.select({
    busRouteId: busRoutesTable.id,
    sourceVariantId: busRouteSourceRowsTable.id,
    routeId: busRoutesTable.routeId,
    rawData: busRouteSourceRowsTable.rawData,
    sourceSheet: busRouteSourceRowsTable.sheetName,
    sourceRow: busRouteSourceRowsTable.sourceRowNumber,
    sourceBusCount: busRouteSourceRowsTable.allocatedBusCount,
    isActive: busRouteSourceRowsTable.isActive,
  }).from(busRouteSourceRowsTable)
    .innerJoin(busRoutesTable, eq(busRouteSourceRowsTable.busRouteId, busRoutesTable.id))
    .where(and(
      eq(busRouteSourceRowsTable.isActive, true),
      eq(busRoutesTable.isActive, true),
    ));
  const sourceValue = (rawData: Record<string, unknown>, ...headers: string[]): string | null => {
    const normalizedHeaders = new Set(headers.map((header) => header.toLocaleLowerCase().replace(/[^a-z0-9]/g, "")));
    for (const [header, value] of Object.entries(rawData)) {
      if (!normalizedHeaders.has(header.toLocaleLowerCase().replace(/[^a-z0-9]/g, "")) || value == null) continue;
      const text = String(value).trim();
      if (text) return text;
    }
    return null;
  };
  const busRouteIds = [...new Set(routes.map((route) => route.busRouteId))];
  const metricRows = busRouteIds.length ? await db.select({
    routeId: busRoutesTable.routeId,
    sourceVariantId: passengerRouteMetricsTable.sourceVariantId,
    mappingStatus: passengerRouteMetricsTable.mappingStatus,
    month: passengerRouteMetricsTable.month,
    passengerCount: passengerRouteMetricsTable.passengerCount,
    tripCount: passengerRouteMetricsTable.tripCount,
    sourceFile: passengerRouteMetricsTable.sourceFile,
    sourceRow: passengerRouteMetricsTable.sourceRow,
    importedAt: passengerRouteMetricsTable.importedAt,
  }).from(passengerRouteMetricsTable)
    .innerJoin(busRoutesTable, eq(passengerRouteMetricsTable.busRouteId, busRoutesTable.id))
    .where(and(
      inArray(passengerRouteMetricsTable.mappingStatus, ["MATCHED_VARIANT", "ROUTE_LEVEL_ONLY"]),
      inArray(passengerRouteMetricsTable.busRouteId, busRouteIds),
    ))
    .orderBy(desc(passengerRouteMetricsTable.month), desc(passengerRouteMetricsTable.importedAt))
  : [];
  const passengerSummaries = analyzePassengerRouteSeries(metricRows
    .filter((metric) => metric.mappingStatus === "MATCHED_VARIANT" && metric.sourceVariantId)
    .map((metric) => ({
      routeId: metric.routeId,
      sourceVariantId: metric.sourceVariantId!,
      mappingStatus: "MATCHED_VARIANT" as const,
      period: metric.month,
      passengerCount: metric.passengerCount,
      tripCount: metric.tripCount,
      sourceFile: metric.sourceFile,
      sourceRow: metric.sourceRow,
      importedAt: metric.importedAt.toISOString(),
    })));
  const familyPassengerSummaries = analyzePassengerRouteFamilies(metricRows
    .filter((metric) => metric.mappingStatus === "ROUTE_LEVEL_ONLY")
    .map((metric) => ({
      routeId: metric.routeId,
      mappingStatus: "ROUTE_LEVEL_ONLY" as const,
      period: metric.month,
      passengerCount: metric.passengerCount,
      tripCount: metric.tripCount,
      sourceFile: metric.sourceFile,
      sourceRow: metric.sourceRow,
      importedAt: metric.importedAt.toISOString(),
    })));
  return recommendNetworkRoutes({
    geography: project.geography,
    campaignAreas: project.campaignAreas,
    targetBuses,
    objective: project.objective,
    targetAreas: strategy?.targetAreas ?? [],
    targetRoads: strategy?.targetRoads ?? [],
    strategyApproved: strategy?.status === "APPROVED",
    routePassengerEvidence: passengerSummaries.flatMap((summary) => summary.latest ? [{
      routeId: summary.routeId,
      sourceVariantId: summary.sourceVariantId,
      source: summary.latest.sourceFile,
      period: summary.latest.period,
      passengerCount: summary.latest.passengerCount,
      tripCount: summary.latest.tripCount,
      sourceRow: summary.latest.sourceRow,
      summary,
    }] : []),
    routeFamilyPassengerEvidence: familyPassengerSummaries.flatMap((summary) => summary.latest ? [{
      routeId: summary.routeId,
      summary,
    }] : []),
    routes: routes.map(({ rawData, ...route }) => ({
      ...route,
      from: sourceValue(rawData, "Starting Station", "From"),
      to: sourceValue(rawData, "Ending Station", "To"),
      via: sourceValue(rawData, "Via"),
      depot: sourceValue(rawData, "Depot Name", "Depot"),
      isRejected: rejectedVariantIds.has(route.sourceVariantId),
    })),
  });
}

const networkRecommendationsHandler = async (req: Request, res: Response): Promise<void> => {
  const projectId = Array.isArray(req.params.projectId) ? req.params.projectId[0] : req.params.projectId;
  if (!projectId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(projectId)) {
    res.status(400).json({ error: "A valid projectId is required" });
    return;
  }
  const [project] = await db.select({
    id: pitchProjectsTable.id,
    geography: pitchProjectsTable.campaignGeography,
    campaignAreas: pitchProjectsTable.campaignAreas,
    targetQuantity: pitchProjectsTable.targetQuantity,
    objective: pitchProjectsTable.pitchObjective,
  }).from(pitchProjectsTable).where(eq(pitchProjectsTable.id, projectId)).limit(1);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const targetValue = req.method === "POST" ? req.body?.targetBuses as unknown : req.query.targetBuses;
  const targetBuses = targetValue === undefined && req.method === "GET"
    ? project.targetQuantity ?? 50
    : typeof targetValue === "number" ? targetValue
      : typeof targetValue === "string" && /^\d+$/.test(targetValue) ? Number(targetValue) : NaN;
  if (!Number.isSafeInteger(targetBuses) || targetBuses <= 0 || targetBuses > 10000) {
    res.status(400).json({ error: "targetBuses must be a positive integer no greater than 10000" });
    return;
  }
  res.json(await buildProjectNetworkRecommendations(project, targetBuses));
};
router.get("/projects/:projectId/network-recommendations", networkRecommendationsHandler);
router.post("/projects/:projectId/network-recommendations", networkRecommendationsHandler);

function sendServiceError(error: unknown, res: Response): void {
  if (!(error instanceof BusPlanServiceError)) throw error;
  res.status(error.status).json(error.status === 409 && error.requiresOverride
    ? {
      error: error.message,
      requiresOverride: true,
      sourceBusCount: error.sourceBusCount,
    }
    : { error: error.message });
}

router.get("/projects/:projectId/bus-plan", async (req, res): Promise<void> => {
  const params = GetProjectBusPlanParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const plan = await getProjectBusPlan(params.data.projectId);
  if (!plan) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  res.json(GetProjectBusPlanResponse.parse(plan));
});

router.post("/projects/:projectId/bus-plan", async (req, res): Promise<void> => {
  const params = AddProjectBusRouteParams.safeParse(req.params);
  const body = AddProjectBusRouteBody.safeParse(req.body);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  try {
    const selection = await addProjectBusRoute(params.data.projectId, body.data);
    res.status(201).json(AddProjectBusRouteResponse.parse(selection));
  } catch (error) {
    sendServiceError(error, res);
  }
});

router.patch("/projects/:projectId/bus-plan/:selectionId", async (req, res): Promise<void> => {
  const params = UpdateProjectBusRouteParams.safeParse(req.params);
  const body = UpdateProjectBusRouteBody.safeParse(req.body);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  try {
    const selection = await updateProjectBusRoute(
      params.data.projectId,
      params.data.selectionId,
      body.data,
    );
    res.json(UpdateProjectBusRouteResponse.parse(selection));
  } catch (error) {
    sendServiceError(error, res);
  }
});

router.delete("/projects/:projectId/bus-plan/:selectionId", async (req, res): Promise<void> => {
  const params = RemoveProjectBusRouteParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const removed = await removeProjectBusRoute(params.data.projectId, params.data.selectionId);
  if (!removed) {
    res.status(404).json({ error: "Project bus route selection not found" });
    return;
  }
  res.sendStatus(204);
});

router.get("/projects/:projectId/media-plan", async (req, res): Promise<void> => {
  const params = GetProjectMediaPlanParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const busPlan = await getProjectBusPlan(params.data.projectId);
  if (!busPlan) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const [projectScope] = await db.select({
    campaignGeography: pitchProjectsTable.campaignGeography,
    campaignAreas: pitchProjectsTable.campaignAreas,
  }).from(pitchProjectsTable).where(eq(pitchProjectsTable.id, params.data.projectId)).limit(1);
  if (!projectScope) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const selectedMedia = await db.select({
    selection: projectInventorySelectionsTable,
    asset: inventoryAssetsTable,
    mediaUnit: inventoryMediaUnitsTable,
  }).from(projectInventorySelectionsTable)
    .innerJoin(inventoryAssetsTable, eq(projectInventorySelectionsTable.inventoryAssetId, inventoryAssetsTable.id))
    .leftJoin(inventoryMediaUnitsTable, and(
      eq(projectInventorySelectionsTable.inventoryMediaUnitId, inventoryMediaUnitsTable.id),
      eq(inventoryMediaUnitsTable.parentInventoryAssetId, inventoryAssetsTable.id),
    ))
    .where(eq(projectInventorySelectionsTable.projectId, params.data.projectId));
  const mediaRows = selectedMedia
    .filter(({ asset }) => isBusShelterSourceFamily(asset.sourceFamily))
    .map(({ selection, asset, mediaUnit }) => ({
      selectionId: selection.id,
      inventoryAssetId: asset.id,
      inventoryMediaUnitId: selection.inventoryMediaUnitId,
      status: selection.status,
      note: selection.note,
      assetCode: asset.assetCode,
      assetType: asset.assetType,
      assetName: asset.assetName,
      area: asset.area ?? asset.areaNormalized,
      campaignGeographyStatus: (() => {
        const inCampaignGeography = isShelterInCampaignGeography({
          area: asset.area,
          areaNormalized: asset.areaNormalized,
        }, projectScope.campaignGeography, projectScope.campaignAreas);
        return campaignGeographyStatusFromEvidence(
          inCampaignGeography,
          projectScope.campaignGeography === "ABU_DHABI",
        );
      })(),
      mediaUnitType: mediaUnit?.unitType ?? null,
      mediaFormat: mediaUnit?.format ?? null,
      currentClient: mediaUnit?.currentClient ?? asset.client,
      availabilityStatus: mediaUnit?.availabilityStatus ?? asset.availability,
      campaignStart: mediaUnit?.campaignStart ?? asset.startDate,
      campaignEnd: mediaUnit?.campaignEnd ?? asset.endDate,
    }));
  const { proposedShelterSelections, rejectedShelterSelections } = partitionShelterSelections(mediaRows);
  res.json(GetProjectMediaPlanResponse.parse({
    projectId: params.data.projectId,
    shelterSelections: proposedShelterSelections,
    rejectedShelterSelections,
    busPlan,
    totalProposedBuses: busPlan.totalProposedBuses,
  }));
});

export default router;