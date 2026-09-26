import { Router, type IRouter } from "express";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  AddProjectLocationBody,
  AddProjectLocationParams,
  AddProjectLocationResponse,
  DecideProjectLocationRecommendationBody,
  DecideProjectLocationRecommendationParams,
  DecideProjectLocationRecommendationResponse,
  DiscoverProjectLocationsBody,
  DiscoverProjectLocationsParams,
  DiscoverProjectLocationsResponse,
  GetProjectLocationRecommendationsParams,
  GetProjectLocationRecommendationsResponse,
  GetProjectLocationStrategyParams,
  GetProjectLocationStrategyResponse,
  ListProjectLocationsParams,
  ListProjectLocationsResponse,
  ReviewProjectLocationBody,
  ReviewProjectLocationParams,
  ReviewProjectLocationResponse,
  SaveProjectLocationStrategyBody,
  SaveProjectLocationStrategyParams,
  SaveProjectLocationStrategyResponse,
} from "@workspace/api-zod";
import {
  db,
  locationRecommendationsTable,
  locationRouteRecommendationsTable,
  inventoryAssetsTable,
  inventoryMediaUnitsTable,
  busRouteSourceRowsTable,
  busRoutesTable,
  claimReviewsTable,
  pitchProjectsTable,
  projectLocationStrategiesTable,
  projectLocationsTable,
} from "@workspace/db";
import {
  LOCATION_RADII,
  buildStoreCoverage,
  discoverLocations,
  linkApprovedProjectPOI,
  recomputeLocationRecommendations,
  recommendBusRoutes,
  validCoordinates,
} from "../lib/location-intelligence";
import { discoverHisenseOfficialLocations } from "../lib/official-location-sources";
import {
  canRefreshDiscoveredProviderCandidate,
  shouldClearProjectPoiLink,
  verifiedAudienceSeed,
} from "../lib/location-intelligence-rules";
import { readShelterConflicts } from "../lib/shelter-conflicts";
import { getProjectIntelligence, loadProjectContext } from "../lib/research";
import {
  campaignGeographyStatus,
  filterLocationsToCampaignGeography,
  isShelterInCampaignGeography,
} from "../lib/location-market-scope";

const router: IRouter = Router();

async function projectExists(projectId: string): Promise<boolean> {
  const [project] = await db.select({ id: pitchProjectsTable.id }).from(pitchProjectsTable)
    .where(eq(pitchProjectsTable.id, projectId));
  return !!project;
}

async function getCampaignScope(projectId: string) {
  const [project] = await db.select({
    campaignGeography: pitchProjectsTable.campaignGeography,
    campaignAreas: pitchProjectsTable.campaignAreas,
  }).from(pitchProjectsTable).where(eq(pitchProjectsTable.id, projectId));
  return project;
}

function locationSourceMetadata(location: typeof projectLocationsTable.$inferSelect) {
  return {
    locationType: location.locationType,
    coordinatesSourceUrl: location.coordinatesSourceUrl,
    evidenceType: location.evidenceType,
    evidenceStatus: location.evidenceStatus,
    sourceDate: location.sourceDate,
  };
}

function locationWithSourceMetadata(
  location: typeof projectLocationsTable.$inferSelect,
  geography?: "DUBAI" | "ABU_DHABI" | "UAE" | "CUSTOM" | null,
  campaignAreas: string[] = [],
) {
  return {
    ...AddProjectLocationResponse.parse(location),
    ...locationSourceMetadata(location),
    campaignGeographyStatus: campaignGeographyStatus(location, geography, campaignAreas),
  };
}

function proposedCategories(project: {
  clientName: string;
  category: string | null;
  productFocus: string | null;
}) {
  const context = `${project.clientName} ${project.category ?? ""} ${project.productFocus ?? ""}`.toLowerCase();
  if (/health|clinic|hospital|pharma/.test(context)) {
    return [{ name: "Clinic or hospital", priority: 1 }, { name: "Pharmacy", priority: 2 }, { name: "Residential area", priority: 3 }];
  }
  if (/school|education|university/.test(context)) {
    return [{ name: "School or university", priority: 1 }, { name: "Family residential area", priority: 2 }, { name: "Community centre", priority: 3 }];
  }
  if (/food|grocery|mart|talabat|delivery|restaurant/.test(context)) {
    return [{ name: "Supermarket or hypermarket", priority: 1 }, { name: "Residential area", priority: 2 }, { name: "Neighborhood centre", priority: 3 }];
  }
  return [{ name: "Client-relevant POI", priority: 1 }, { name: "Residential area", priority: 2 }];
}

async function ensureStrategy(projectId: string) {
  const [existing] = await db.select().from(projectLocationStrategiesTable)
    .where(eq(projectLocationStrategiesTable.projectId, projectId));
  if (existing) return existing;
  const project = await loadProjectContext(projectId);
  if (!project) return undefined;
  const intelligence = await getProjectIntelligence(project);
  const audienceClaims = intelligence.claims.filter((claim) =>
    !claim.isDemo && claim.status === "approved" &&
    /(^|\.)target_audience$|(^|\.)audience$/i.test(claim.category));
  const reviews = audienceClaims.length
    ? await db.select({
      claimId: claimReviewsTable.claimId,
      decision: claimReviewsTable.decision,
      sourceQuote: claimReviewsTable.sourceQuote,
      quoteVerifiedAt: claimReviewsTable.quoteVerifiedAt,
    }).from(claimReviewsTable)
      .where(eq(claimReviewsTable.projectId, projectId))
      .orderBy(desc(claimReviewsTable.reviewedAt))
    : [];
  const latestReviewByClaim = new Map<string, typeof reviews[number]>();
  for (const review of reviews) {
    if (!latestReviewByClaim.has(review.claimId)) latestReviewByClaim.set(review.claimId, review);
  }
  const audience = audienceClaims
    .map((claim) => verifiedAudienceSeed(claim, latestReviewByClaim.get(claim.id)))
    .find((value): value is string => value !== null) ?? null;
  // Do not infer target areas or roads from project market or broad research prose.
  // Only the strategy's approved client-specific category fallback is inferred here.
  const [strategy] = await db.insert(projectLocationStrategiesTable).values({
    projectId,
    categories: proposedCategories(project),
    audience,
    status: "DRAFT",
  }).onConflictDoNothing().returning();
  if (strategy) return strategy;
  const [concurrentStrategy] = await db.select().from(projectLocationStrategiesTable)
    .where(eq(projectLocationStrategiesTable.projectId, projectId));
  return concurrentStrategy;
}

router.get("/projects/:projectId/location-strategy", async (req, res): Promise<void> => {
  const params = GetProjectLocationStrategyParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const strategy = await ensureStrategy(params.data.projectId);
  if (!strategy) { res.status(404).json({ error: "Project not found" }); return; }
  res.json(GetProjectLocationStrategyResponse.parse(strategy));
});

router.put("/projects/:projectId/location-strategy", async (req, res): Promise<void> => {
  const params = SaveProjectLocationStrategyParams.safeParse(req.params);
  const body = SaveProjectLocationStrategyBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: !params.success ? params.error.message : body.error?.message ?? "Invalid request body" });
    return;
  }
  if (!await projectExists(params.data.projectId)) { res.status(404).json({ error: "Project not found" }); return; }
  const strategy = await db.transaction(async (tx) => {
    const [saved] = await tx.insert(projectLocationStrategiesTable).values({
      projectId: params.data.projectId,
      ...body.data,
    }).onConflictDoUpdate({
      target: projectLocationStrategiesTable.projectId,
      set: { ...body.data, updatedAt: new Date() },
    }).returning();
    await tx.update(locationRecommendationsTable).set({ isCurrent: false, updatedAt: new Date() })
      .where(eq(locationRecommendationsTable.projectId, params.data.projectId));
    await tx.update(locationRouteRecommendationsTable).set({ isCurrent: false, updatedAt: new Date() })
      .where(eq(locationRouteRecommendationsTable.projectId, params.data.projectId));
    return saved;
  });
  res.json(SaveProjectLocationStrategyResponse.parse(strategy));
});

router.get("/projects/:projectId/locations", async (req, res): Promise<void> => {
  const params = ListProjectLocationsParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  if (!await projectExists(params.data.projectId)) { res.status(404).json({ error: "Project not found" }); return; }
  const locations = await db.select().from(projectLocationsTable)
    .where(eq(projectLocationsTable.projectId, params.data.projectId));
  const project = await getCampaignScope(params.data.projectId);
  const parsed = ListProjectLocationsResponse.parse(locations);
  res.json(parsed.map((_location, index) => locationWithSourceMetadata(
    locations[index]!,
    project?.campaignGeography,
    project?.campaignAreas ?? [],
  )));
});

router.post("/projects/:projectId/locations", async (req, res): Promise<void> => {
  const params = AddProjectLocationParams.safeParse(req.params);
  const body = AddProjectLocationBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: !params.success ? params.error.message : body.error?.message ?? "Invalid request body" });
    return;
  }
  if (!await projectExists(params.data.projectId)) { res.status(404).json({ error: "Project not found" }); return; }
  const project = await getCampaignScope(params.data.projectId);
  const { sourceUrl, ...values } = body.data;
  const [location] = await db.insert(projectLocationsTable).values({
    ...values,
    projectId: params.data.projectId,
    provider: "USER",
    sourceUrl: sourceUrl ?? null,
    evidenceType: "USER_PROVIDED",
    evidenceStatus: "USER_PROVIDED",
    locationType: "UNVERIFIED_CANDIDATE",
    confidence: "USER_PROVIDED",
    reviewStatus: "NEEDS_REVIEW",
  }).returning();
  res.status(201).json(location ? locationWithSourceMetadata(
    location,
    project?.campaignGeography,
    project?.campaignAreas ?? [],
  ) : null);
});

router.post("/projects/:projectId/locations/discover", async (req, res): Promise<void> => {
  const params = DiscoverProjectLocationsParams.safeParse(req.params);
  const body = DiscoverProjectLocationsBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: !params.success ? params.error.message : body.error?.message ?? "Invalid request body" });
    return;
  }
  if (!await projectExists(params.data.projectId)) { res.status(404).json({ error: "Project not found" }); return; }
  const project = await getCampaignScope(params.data.projectId);
  try {
    const candidates = await discoverLocations(body.data.query, body.data.limit ?? 20);
    const officialCandidates = body.data.role === "CLIENT" && body.data.brand
      ? await discoverHisenseOfficialLocations(`${body.data.query} ${body.data.brand}`)
      : [];
    candidates.push(...officialCandidates);
    const items: Array<typeof projectLocationsTable.$inferSelect> = [];
    const unique = new Set<string>();
    for (const candidate of candidates) {
      const providerKey = `${body.data.role}:${candidate.providerId}:${candidate.sourceReference}`;
      if (unique.has(providerKey)) continue;
      unique.add(providerKey);
      const sourceFields = {
        name: candidate.name,
        category: candidate.category,
        address: candidate.address,
        latitude: candidate.latitude,
        longitude: candidate.longitude,
        area: candidate.area,
        provider: candidate.providerId,
        providerId: candidate.sourceReference,
        sourceReference: candidate.sourceReference,
        sourceUrl: candidate.sourceUrl,
        evidence: candidate.evidence,
        locationType: candidate.locationType,
        coordinatesSourceUrl: candidate.coordinatesSourceUrl,
        evidenceType: candidate.evidenceType,
        evidenceStatus: candidate.evidenceStatus,
        sourceDate: candidate.sourceDate,
        retrievedAt: new Date(),
        confidence: candidate.confidence,
      };
      const identity = [
        eq(projectLocationsTable.projectId, params.data.projectId),
        eq(projectLocationsTable.role, body.data.role),
        eq(projectLocationsTable.provider, candidate.providerId),
        eq(projectLocationsTable.providerId, candidate.sourceReference),
      ];
      const [inserted] = await db.insert(projectLocationsTable).values({
        projectId: params.data.projectId,
        role: body.data.role,
        brand: body.data.brand ?? null,
        reviewStatus: "NEEDS_REVIEW",
        ...sourceFields,
      }).onConflictDoNothing().returning();
      if (inserted) items.push(inserted);
      else {
        const [existing] = await db.select().from(projectLocationsTable).where(and(...identity));
        if (!existing) continue;
        const candidateIdentity = {
          role: body.data.role,
          provider: candidate.providerId,
          providerId: candidate.sourceReference,
        };
        if (!canRefreshDiscoveredProviderCandidate(existing, candidateIdentity)) {
          items.push(existing);
          continue;
        }
        const [refreshed] = await db.update(projectLocationsTable).set({
          ...sourceFields,
          updatedAt: new Date(),
        }).where(and(
          eq(projectLocationsTable.id, existing.id),
          eq(projectLocationsTable.reviewStatus, "NEEDS_REVIEW"),
          ...identity,
        )).returning();
        if (refreshed) items.push(refreshed);
        else {
          const [latest] = await db.select().from(projectLocationsTable).where(and(...identity));
          if (latest) items.push(latest);
        }
      }
    }
    const parsed = DiscoverProjectLocationsResponse.parse(items);
    res.json(parsed.map((_location, index) => locationWithSourceMetadata(
      items[index]!,
      project?.campaignGeography,
      project?.campaignAreas ?? [],
    )));
  } catch (error) {
    req.log.error({ err: error }, "Location provider search failed");
    const message = error instanceof Error
      ? error.message.slice(0, 300)
      : "Location provider search failed; candidates were not verified.";
    res.status(502).json({ error: message });
  }
});

router.put("/projects/:projectId/locations/:locationId/review", async (req, res): Promise<void> => {
  const params = ReviewProjectLocationParams.safeParse(req.params);
  const body = ReviewProjectLocationBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: !params.success ? params.error.message : body.error?.message ?? "Invalid request body" });
    return;
  }
  const [existingLocation] = await db.select({ role: projectLocationsTable.role })
    .from(projectLocationsTable).where(and(
      eq(projectLocationsTable.id, params.data.locationId),
      eq(projectLocationsTable.projectId, params.data.projectId),
    ));
  if (!existingLocation) { res.status(404).json({ error: "Project or location not found" }); return; }
  const [location] = await db.update(projectLocationsTable).set({
    reviewStatus: body.data.decision,
    reviewNote: body.data.note ?? null,
    ...(shouldClearProjectPoiLink(existingLocation.role, body.data.decision) ? { poiId: null } : {}),
    updatedAt: new Date(),
  }).where(and(
    eq(projectLocationsTable.id, params.data.locationId),
    eq(projectLocationsTable.projectId, params.data.projectId),
  )).returning();
  if (!location) { res.status(404).json({ error: "Project or location not found" }); return; }
  await db.update(locationRecommendationsTable).set({ isCurrent: false, updatedAt: new Date() })
    .where(eq(locationRecommendationsTable.projectId, params.data.projectId));
  await db.update(locationRouteRecommendationsTable).set({ isCurrent: false, updatedAt: new Date() })
    .where(eq(locationRouteRecommendationsTable.projectId, params.data.projectId));
  let responseLocation = location;
  if (location.role === "POI" && body.data.decision === "APPROVED") {
    try {
      await linkApprovedProjectPOI(params.data.projectId, location.id);
      const [linked] = await db.select().from(projectLocationsTable).where(and(
        eq(projectLocationsTable.id, location.id),
        eq(projectLocationsTable.projectId, params.data.projectId),
      ));
      if (linked) responseLocation = linked;
    } catch (error) {
      req.log.error({ err: error, projectId: params.data.projectId, locationId: location.id }, "Could not link approved POI to global model");
      res.status(500).json({ error: "Location review was saved, but linking the approved POI failed. Retry the approval to complete linking." });
      return;
    }
  }
  const projectScope = await getCampaignScope(params.data.projectId);
  res.json({
    ...ReviewProjectLocationResponse.parse(responseLocation),
    ...locationSourceMetadata(responseLocation),
    campaignGeographyStatus: campaignGeographyStatus(
      responseLocation,
      projectScope?.campaignGeography,
      projectScope?.campaignAreas ?? [],
    ),
  });
});

router.get("/projects/:projectId/store-coverage", async (req, res): Promise<void> => {
  const params = GetProjectLocationStrategyParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  if (!await projectExists(params.data.projectId)) { res.status(404).json({ error: "Project not found" }); return; }

  const project = await getCampaignScope(params.data.projectId);
  const locations = filterLocationsToCampaignGeography(await db.select().from(projectLocationsTable).where(and(
    eq(projectLocationsTable.projectId, params.data.projectId),
    eq(projectLocationsTable.role, "CLIENT"),
    eq(projectLocationsTable.reviewStatus, "APPROVED"),
  )), project?.campaignGeography, project?.campaignAreas ?? []);
  const inventory = await db.select().from(inventoryAssetsTable).where(and(
    eq(inventoryAssetsTable.isActive, true),
    eq(inventoryAssetsTable.sourceFamily, "BUS_SHELTER"),
    eq(inventoryAssetsTable.sourceLifecycleStatus, "ACTIVE"),
    eq(inventoryAssetsTable.assetType, "Bus Shelter"),
  ));
  const assets = inventory.filter((asset) => isShelterInCampaignGeography(
    asset,
    project?.campaignGeography,
    project?.campaignAreas ?? [],
  ));
  const units = assets.length
    ? await db.select().from(inventoryMediaUnitsTable).where(and(
      inArray(inventoryMediaUnitsTable.parentInventoryAssetId, assets.map(({ id }) => id)),
      eq(inventoryMediaUnitsTable.lifecycleStatus, "ACTIVE"),
    ))
    : [];
  res.json({
    projectId: params.data.projectId,
    ...buildStoreCoverage(locations, assets, units),
  });
});

router.get("/projects/:projectId/location-recommendations/:radiusMeters", async (req, res): Promise<void> => {
  const params = GetProjectLocationRecommendationsParams.safeParse({
    ...req.params,
    radiusMeters: Number(req.params.radiusMeters),
  });
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  if (!(LOCATION_RADII as readonly number[]).includes(params.data.radiusMeters)) {
    res.status(400).json({ error: "Unsupported straight-line distance radius" }); return;
  }
  if (!await projectExists(params.data.projectId)) { res.status(404).json({ error: "Project not found" }); return; }
  const strategy = await ensureStrategy(params.data.projectId);
  const matched = await recomputeLocationRecommendations(params.data.projectId, params.data.radiusMeters);
  const routes = await recommendBusRoutes(params.data.projectId, strategy);
  const shelters = matched.responseRecommendations.map(({ relationship: _relationship, ...recommendation }) => recommendation);
  const limitations = [...matched.limitations];
  if (matched.strategyStatus === "APPROVED" && routes.length === 0) {
    limitations.push("No active source route variant matched the approved target areas, roads, or location categories.");
  }
  res.json(GetProjectLocationRecommendationsResponse.parse({
    projectId: params.data.projectId,
    radiusMeters: params.data.radiusMeters,
    strategyStatus: matched.strategyStatus,
    shelters,
    routes,
    limitations,
  }));
});

router.put("/projects/:projectId/location-recommendations/:recommendationId/decision", async (req, res): Promise<void> => {
  const params = DecideProjectLocationRecommendationParams.safeParse(req.params);
  const body = DecideProjectLocationRecommendationBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: !params.success ? params.error.message : body.error?.message ?? "Invalid request body" });
    return;
  }
  const [strategy] = await db.select({ status: projectLocationStrategiesTable.status })
    .from(projectLocationStrategiesTable)
    .where(eq(projectLocationStrategiesTable.projectId, params.data.projectId));
  if (strategy?.status !== "APPROVED") {
    await db.update(locationRecommendationsTable).set({ isCurrent: false, updatedAt: new Date() })
      .where(eq(locationRecommendationsTable.projectId, params.data.projectId));
    await db.update(locationRouteRecommendationsTable).set({ isCurrent: false, updatedAt: new Date() })
      .where(eq(locationRouteRecommendationsTable.projectId, params.data.projectId));
    res.status(409).json({ error: "Approve the project location strategy before acting on recommendations." });
    return;
  }

  const [existingShelterRecommendation] = await db.select().from(locationRecommendationsTable).where(and(
    eq(locationRecommendationsTable.id, params.data.recommendationId),
    eq(locationRecommendationsTable.projectId, params.data.projectId),
  ));
  if (existingShelterRecommendation) {
    if (!existingShelterRecommendation.isCurrent) {
      res.status(409).json({ error: "This shelter recommendation is obsolete; refresh recommendations before deciding." });
      return;
    }
    if (!existingShelterRecommendation.inventoryAssetId || !existingShelterRecommendation.inventoryMediaUnitId) {
      res.status(409).json({ error: "This recommendation no longer references an eligible shelter media unit." });
      return;
    }
    const [eligibleAsset] = await db.select().from(inventoryAssetsTable).where(and(
      eq(inventoryAssetsTable.id, existingShelterRecommendation.inventoryAssetId),
      eq(inventoryAssetsTable.isActive, true),
      eq(inventoryAssetsTable.sourceFamily, "BUS_SHELTER"),
      eq(inventoryAssetsTable.sourceLifecycleStatus, "ACTIVE"),
      eq(inventoryAssetsTable.assetType, "Bus Shelter"),
    ));
    const [eligibleUnit] = await db.select().from(inventoryMediaUnitsTable).where(and(
      eq(inventoryMediaUnitsTable.id, existingShelterRecommendation.inventoryMediaUnitId),
      eq(inventoryMediaUnitsTable.parentInventoryAssetId, existingShelterRecommendation.inventoryAssetId),
      eq(inventoryMediaUnitsTable.lifecycleStatus, "ACTIVE"),
    ));
    if (!eligibleAsset || !eligibleUnit || !validCoordinates(eligibleAsset.latitude, eligibleAsset.longitude) ||
        eligibleAsset.syncReviewReasons.length > 0) {
      await db.update(locationRecommendationsTable).set({ isCurrent: false, updatedAt: new Date() })
        .where(eq(locationRecommendationsTable.id, existingShelterRecommendation.id));
      res.status(409).json({ error: "The shelter or media unit is removed, conflicted, or otherwise ineligible." });
      return;
    }
    const campaignScope = await getCampaignScope(params.data.projectId);
    if (!isShelterInCampaignGeography(
      eligibleAsset,
      campaignScope?.campaignGeography,
      campaignScope?.campaignAreas ?? [],
    )) {
      await db.update(locationRecommendationsTable).set({ isCurrent: false, updatedAt: new Date() })
        .where(eq(locationRecommendationsTable.id, existingShelterRecommendation.id));
      res.status(409).json({ error: "The shelter is outside the campaign geography and cannot be selected." });
      return;
    }
    if (process.env.SHELTER_MASTER_SHEET_ID?.trim()) {
      try {
        const conflicts = await readShelterConflicts();
        if (conflicts.some((conflict) => conflict.sourceKey === eligibleAsset.sourceKey)) {
          await db.update(locationRecommendationsTable).set({ isCurrent: false, updatedAt: new Date() })
            .where(eq(locationRecommendationsTable.id, existingShelterRecommendation.id));
          res.status(409).json({ error: "The shelter has an unresolved source conflict and cannot be selected." });
          return;
        }
      } catch (error) {
        req.log.error({ err: error }, "Could not verify shelter source conflicts before recommendation decision");
        res.status(503).json({ error: "Could not verify current source conflicts. Retry before deciding." });
        return;
      }
    }
  }

  const [existingRouteRecommendation] = existingShelterRecommendation
    ? []
    : await db.select().from(locationRouteRecommendationsTable).where(and(
      eq(locationRouteRecommendationsTable.id, params.data.recommendationId),
      eq(locationRouteRecommendationsTable.projectId, params.data.projectId),
    ));
  if (!existingShelterRecommendation && existingRouteRecommendation) {
    if (!existingRouteRecommendation.isCurrent) {
      res.status(409).json({ error: "This route recommendation is obsolete; refresh recommendations before deciding." });
      return;
    }
    const [activeVariant] = await db.select({
      source: busRouteSourceRowsTable,
      route: busRoutesTable,
    }).from(busRouteSourceRowsTable)
      .innerJoin(busRoutesTable, eq(busRouteSourceRowsTable.busRouteId, busRoutesTable.id))
      .where(and(
        eq(busRouteSourceRowsTable.id, existingRouteRecommendation.sourceVariantId),
        eq(busRouteSourceRowsTable.isActive, true),
        eq(busRoutesTable.isActive, true),
      ));
    if (!activeVariant || (activeVariant.source.allocatedBusCount !== null &&
        activeVariant.source.allocatedBusCount <= 0) ||
        (activeVariant.source.allocatedBusCount !== null &&
          existingRouteRecommendation.suggestedQuantity > activeVariant.source.allocatedBusCount)) {
      await db.update(locationRouteRecommendationsTable).set({ isCurrent: false, updatedAt: new Date() })
        .where(eq(locationRouteRecommendationsTable.id, existingRouteRecommendation.id));
      res.status(409).json({ error: "The source route variant is inactive or no longer supports this planning quantity." });
      return;
    }
  }
  if (!existingShelterRecommendation && !existingRouteRecommendation) {
    res.status(404).json({ error: "Project recommendation not found" });
    return;
  }

  const [recommendation] = existingShelterRecommendation
    ? await db.update(locationRecommendationsTable).set({
    decision: body.data.decision,
    decisionReason: body.data.reason ?? null,
    decisionNote: body.data.note ?? null,
    isSelected: body.data.decision === "SHORTLISTED",
    updatedAt: new Date(),
    isCurrent: true,
  }).where(and(
      eq(locationRecommendationsTable.id, params.data.recommendationId),
      eq(locationRecommendationsTable.projectId, params.data.projectId),
      eq(locationRecommendationsTable.isCurrent, true),
    )).returning()
    : [];
  if (recommendation) {
    res.json(DecideProjectLocationRecommendationResponse.parse(recommendation));
    return;
  }
  const [routeRecommendation] = existingRouteRecommendation ? await db.update(locationRouteRecommendationsTable).set({
    decision: body.data.decision,
    decisionReason: body.data.reason ?? null,
    decisionNote: body.data.note ?? null,
    updatedAt: new Date(),
    isCurrent: true,
  }).where(and(
    eq(locationRouteRecommendationsTable.id, params.data.recommendationId),
    eq(locationRouteRecommendationsTable.projectId, params.data.projectId),
    eq(locationRouteRecommendationsTable.isCurrent, true),
  )).returning() : [];
  if (!routeRecommendation) { res.status(404).json({ error: "Project recommendation not found" }); return; }
  res.json(DecideProjectLocationRecommendationResponse.parse({
    id: routeRecommendation.id,
    projectId: routeRecommendation.projectId,
    inventoryAssetId: null,
    inventoryMediaUnitId: null,
    decision: routeRecommendation.decision,
    decisionReason: routeRecommendation.decisionReason,
    decisionNote: routeRecommendation.decisionNote,
    isCurrent: routeRecommendation.isCurrent,
    updatedAt: routeRecommendation.updatedAt,
  }));
});

export default router;