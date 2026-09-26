import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  assetPoiRelationshipsTable,
  busRouteSourceRowsTable,
  busRoutesTable,
  db,
  inventoryAssetsTable,
  inventoryMediaUnitsTable,
  locationRecommendationsTable,
  locationRouteRecommendationsTable,
  pointsOfInterestTable,
  pitchProjectsTable,
  projectLocationStrategiesTable,
  projectLocationsTable,
} from "@workspace/db";
import { distanceMeters } from "./inventory";
import {
  filterLocationsToCampaignGeography,
  isShelterInCampaignGeography,
  routeHasCampaignGeographyEvidence,
} from "./location-market-scope";
import {
  calculateLocationScore,
  locationRecommendationEvidence,
  matchPoiCategoryPriority,
  shouldRecommendForLocation,
  validCoordinates,
} from "./location-intelligence-rules";
export {
  calculateLocationScore,
  locationRecommendationEvidence,
  matchPoiCategoryPriority,
  shouldRecommendForLocation,
  validCoordinates,
} from "./location-intelligence-rules";
import { locationProvider } from "./location-providers";
export {
  buildStoreCoverage,
  isWithinStraightLineRadius,
  LOCATION_RADII,
} from "./location-intelligence-coverage";
import { LOCATION_RADII } from "./location-intelligence-coverage";

export const LOCATION_SCORING_VERSION = "location-v1";

export async function discoverLocations(query: string, limit: number) {
  return locationProvider.search(query, limit);
}

export async function linkApprovedProjectPOI(projectId: string, projectLocationId: string): Promise<string | null> {
  return db.transaction(async (tx) => {
    const [location] = await tx.select().from(projectLocationsTable).where(and(
      eq(projectLocationsTable.id, projectLocationId),
      eq(projectLocationsTable.projectId, projectId),
      eq(projectLocationsTable.role, "POI"),
      eq(projectLocationsTable.reviewStatus, "APPROVED"),
    ));
    if (!location) return null;
    if (location.poiId) return location.poiId;

    const globalSourceReference = location.sourceReference
      ? `${location.provider ?? "UNKNOWN"}:${location.sourceReference}`
      : null;
    let globalPoiId: string | null = null;
    if (globalSourceReference) {
      const [existing] = await tx.select({ id: pointsOfInterestTable.id }).from(pointsOfInterestTable)
        .where(eq(pointsOfInterestTable.sourceReference, globalSourceReference));
      globalPoiId = existing?.id ?? null;
    }
    if (!globalPoiId) {
      const [created] = await tx.insert(pointsOfInterestTable).values({
        name: location.name,
        category: location.category,
        address: location.address,
        geography: location.area,
        latitude: location.latitude,
        longitude: location.longitude,
        source: location.provider ?? (location.confidence === "USER_PROVIDED" ? "USER" : "UNKNOWN"),
        sourceReference: globalSourceReference,
        sourceUrl: location.sourceUrl,
        retrievedAt: location.retrievedAt,
        brand: location.brand,
      }).onConflictDoNothing().returning({ id: pointsOfInterestTable.id });
      globalPoiId = created?.id ?? null;
      if (!globalPoiId && globalSourceReference) {
        const [existing] = await tx.select({ id: pointsOfInterestTable.id }).from(pointsOfInterestTable)
          .where(eq(pointsOfInterestTable.sourceReference, globalSourceReference));
        globalPoiId = existing?.id ?? null;
      }
    }
    if (!globalPoiId) throw new Error("Could not link the approved project POI to the global POI model.");
    const [updated] = await tx.update(projectLocationsTable).set({
      poiId: globalPoiId,
      updatedAt: new Date(),
    }).where(and(
      eq(projectLocationsTable.id, projectLocationId),
      eq(projectLocationsTable.projectId, projectId),
      isNull(projectLocationsTable.poiId),
    )).returning({ poiId: projectLocationsTable.poiId });
    if (updated?.poiId) return updated.poiId;
    const [current] = await tx.select({ poiId: projectLocationsTable.poiId }).from(projectLocationsTable)
      .where(and(
        eq(projectLocationsTable.id, projectLocationId),
        eq(projectLocationsTable.projectId, projectId),
      ));
    return current?.poiId ?? globalPoiId;
  });
}

export async function recomputeLocationRecommendations(projectId: string, radiusMeters: number) {
  await db.update(locationRecommendationsTable).set({ isCurrent: false, updatedAt: new Date() }).where(and(
    eq(locationRecommendationsTable.projectId, projectId),
    eq(locationRecommendationsTable.matchingRadiusMeters, radiusMeters),
  ));
  const [strategy] = await db.select().from(projectLocationStrategiesTable)
    .where(eq(projectLocationStrategiesTable.projectId, projectId));
  const [project] = await db.select({
    campaignGeography: pitchProjectsTable.campaignGeography,
    campaignAreas: pitchProjectsTable.campaignAreas,
  }).from(pitchProjectsTable)
    .where(eq(pitchProjectsTable.id, projectId));
  const approvedLocations = await db.select().from(projectLocationsTable).where(and(
    eq(projectLocationsTable.projectId, projectId),
    eq(projectLocationsTable.reviewStatus, "APPROVED"),
  ));
  const inScopeApprovedLocations = filterLocationsToCampaignGeography(
    approvedLocations,
    project?.campaignGeography,
    project?.campaignAreas ?? [],
  );
  const approvedWithCoordinates = inScopeApprovedLocations.filter((location) =>
    validCoordinates(location.latitude, location.longitude));
  const client = approvedWithCoordinates.filter((location) => location.role === "CLIENT");
  const competitors = approvedWithCoordinates.filter((location) => location.role === "COMPETITOR");
  const pois = approvedWithCoordinates.filter((location) => location.role === "POI");
  for (const location of pois) {
    if (!location.poiId) await linkApprovedProjectPOI(projectId, location.id);
  }
  const locations = [...client, ...competitors, ...pois];
  await db.delete(assetPoiRelationshipsTable).where(and(
    eq(assetPoiRelationshipsTable.projectId, projectId),
    eq(assetPoiRelationshipsTable.radiusMeters, radiusMeters),
  ));

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
      inArray(inventoryMediaUnitsTable.parentInventoryAssetId, assets.map((asset) => asset.id)),
      eq(inventoryMediaUnitsTable.lifecycleStatus, "ACTIVE"),
    ))
    : [];

  const relevantAssets = new Map<string, {
    asset: typeof assets[number];
    nearest: { location: typeof locations[number]; distanceMeters: number } | null;
    relationships: Array<{ location: typeof locations[number]; distanceMeters: number }>;
  }>();
  for (const asset of assets) {
    if (!validCoordinates(asset.latitude, asset.longitude)) continue;
    if (asset.syncReviewReasons.length > 0) continue;
    const relationships = locations.map((location) => ({
      location,
      distanceMeters: distanceMeters(asset.latitude!, asset.longitude!, location.latitude!, location.longitude!),
    })).filter((relationship) => relationship.distanceMeters <= radiusMeters);
    for (const relationship of relationships) {
      await db.insert(assetPoiRelationshipsTable).values({
        projectId,
        inventoryAssetId: asset.id,
        poiId: relationship.location.id,
        relationshipType: relationship.location.role,
        radiusMeters,
        distanceMeters: relationship.distanceMeters,
      }).onConflictDoUpdate({
        target: [
          assetPoiRelationshipsTable.projectId,
          assetPoiRelationshipsTable.inventoryAssetId,
          assetPoiRelationshipsTable.poiId,
          assetPoiRelationshipsTable.radiusMeters,
        ],
        set: { distanceMeters: relationship.distanceMeters, updatedAt: new Date() },
      });
    }
    const relevant = relationships.filter((relationship) => relationship.location.role === "POI");
    const targetAreaMatch = strategy?.status === "APPROVED" && strategy.targetAreas.some((area) =>
      [asset.area, asset.areaNormalized].some((value) =>
        !!value && (value.toLowerCase().includes(area.toLowerCase()) || area.toLowerCase().includes(value.toLowerCase()))));
    const targetRoadMatch = strategy?.status === "APPROVED" && strategy.targetRoads.some((road) =>
      [asset.road, asset.roadNormalized].some((value) =>
        !!value && (value.toLowerCase().includes(road.toLowerCase()) || road.toLowerCase().includes(value.toLowerCase()))));
    if (shouldRecommendForLocation({
      hasNearbyPoi: relevant.length > 0,
      matchesTargetArea: !!targetAreaMatch,
      matchesTargetRoad: !!targetRoadMatch,
    })) {
      relevantAssets.set(asset.id, {
        asset,
        nearest: relevant.sort((a, b) => a.distanceMeters - b.distanceMeters)[0] ?? null,
        relationships,
      });
    }
  }

  const limitations: string[] = [];
  if (!strategy || strategy.status !== "APPROVED") {
    limitations.push("Approve a location strategy before recommendations are generated.");
  }
  if (!pois.length) limitations.push("No approved, coordinate-backed POIs are available; proximity recommendations are unavailable.");
  limitations.push("Availability not verified: empty client fields are not treated as sellable availability.");
  limitations.push("Audience volume, traffic, impressions, and reach are not supported by approved data.");

  const responseRecommendations = [];
  if (strategy?.status === "APPROVED") {
    for (const { asset, nearest, relationships } of relevantAssets.values()) {
      for (const unit of units.filter((candidate) => candidate.parentInventoryAssetId === asset.id)) {
        const format = `${unit.format}_${unit.unitType === "TOP_PANEL" ? "TOP_PANEL" : "MUPI"}`;
        const components = nearest ? [{
          criterion: "POI proximity",
          points: Math.max(0, Math.round(40 * (1 - nearest.distanceMeters / radiusMeters))),
          maximum: 40,
          explanation: `${Math.round(nearest.distanceMeters)} m straight-line from approved ${nearest.location.category} "${nearest.location.name}" (radius ${radiusMeters} m).`,
        }] : [];
        const categoryPriorityMatch = relationships
          .filter((relationship) => relationship.location.role === "POI")
          .map((relationship) => ({
            relationship,
            priorityMatch: matchPoiCategoryPriority(relationship.location.category, strategy.categories),
          }))
          .filter((entry) => entry.priorityMatch !== null)
          .sort((a, b) => (a.priorityMatch?.priority ?? 99) - (b.priorityMatch?.priority ?? 99))[0];
        if (categoryPriorityMatch?.priorityMatch) {
          const { relationship, priorityMatch } = categoryPriorityMatch;
          const points = Math.min(10, Math.max(0, 12 - 2 * priorityMatch.priority));
          components.push({
            criterion: "Approved POI category priority",
            points,
            maximum: 10,
            explanation: `Approved POI category "${relationship.location.category}" matches strategy category "${priorityMatch.category}" (priority ${priorityMatch.priority}/5), adding ${points}/10 points.`,
          });
        }
        if (strategy.targetAreas.length || strategy.targetRoads.length) {
          const matchedArea = strategy.targetAreas.find((area) =>
            [asset.area, asset.areaNormalized].some((value) =>
              !!value && (value.toLowerCase().includes(area.toLowerCase()) || area.toLowerCase().includes(value.toLowerCase()))));
          const matchedRoad = strategy.targetRoads.find((road) =>
            [asset.road, asset.roadNormalized].some((value) =>
              !!value && (value.toLowerCase().includes(road.toLowerCase()) || road.toLowerCase().includes(value.toLowerCase()))));
          const matchedTarget = matchedArea ?? matchedRoad;
          components.push({
            criterion: "Target area or road",
            points: matchedTarget ? 20 : 0,
            maximum: 20,
            explanation: matchedArea
              ? `Located in approved target area ${matchedArea}.`
              : matchedRoad ? `Located on approved target road ${matchedRoad}.` : "Does not match approved target areas or roads.",
          });
        }
        const clientRelationship = relationships
          .filter((relationship) => relationship.location.role === "CLIENT")
          .sort((a, b) => a.distanceMeters - b.distanceMeters)[0];
        if (client.length) {
          const points = clientRelationship
            ? Math.max(0, Math.round(10 * (1 - clientRelationship.distanceMeters / radiusMeters)))
            : 0;
          components.push({
            criterion: "Client location proximity",
            points,
            maximum: 10,
            explanation: clientRelationship
              ? `${Math.round(clientRelationship.distanceMeters)} m straight-line from approved client location "${clientRelationship.location.name}".`
              : "No approved client location is within the selected radius.",
          });
        }
        const competitorRelationship = relationships
          .filter((relationship) => relationship.location.role === "COMPETITOR")
          .sort((a, b) => a.distanceMeters - b.distanceMeters)[0];
        if (competitors.length) {
          const points = competitorRelationship
            ? Math.max(0, Math.round(10 * (1 - competitorRelationship.distanceMeters / radiusMeters)))
            : 0;
          components.push({
            criterion: "Competitor-area relevance",
            points,
            maximum: 10,
            explanation: competitorRelationship
              ? `${Math.round(competitorRelationship.distanceMeters)} m straight-line from approved competitor location "${competitorRelationship.location.name}".`
              : "No approved competitor location is within the selected radius.",
          });
        }
        if (strategy.preferredFormats.length) {
          const matchedFormat = strategy.preferredFormats.includes(format);
          components.push({
            criterion: "Preferred format",
            points: matchedFormat ? 20 : 0,
            maximum: 20,
            explanation: matchedFormat ? `${format} matches the preferred media format.` : `${format} does not match the preferred formats.`,
          });
        }
        const calculated = calculateLocationScore(components);
        const explanation = [
          ...(nearest ? [components[0]!.explanation] : []),
          ...components.slice(1).map((component) => component.explanation),
          ...(!nearest ? ["Matched approved target-area/road strategy; no approved nearby POI with coordinates was found."] : []),
          "Distance is straight-line, not walking or driving distance.",
        ];
        const missingInformation = [
          "Availability not verified",
          "Audience volume unavailable",
          "Traffic and impressions unavailable",
        ];
        const [saved] = await db.insert(locationRecommendationsTable).values({
          projectId,
          inventoryAssetId: asset.id,
          inventoryMediaUnitId: unit.id,
          matchingRadiusMeters: radiusMeters,
          area: asset.area ?? "",
          rationale: explanation.join(" "),
          fitScore: calculated.score,
          reasons: explanation,
          explanation: locationRecommendationEvidence(calculated.components, nearest?.distanceMeters ?? null),
          missingInformation,
          scoringVersion: LOCATION_SCORING_VERSION,
          isCurrent: true,
        }).onConflictDoUpdate({
          target: [
            locationRecommendationsTable.projectId,
            locationRecommendationsTable.inventoryMediaUnitId,
            locationRecommendationsTable.matchingRadiusMeters,
          ],
          set: {
            area: asset.area ?? "",
            rationale: explanation.join(" "),
            fitScore: calculated.score,
            reasons: explanation,
            explanation: { components: calculated.components, distanceMeters: nearest?.distanceMeters ?? null },
            missingInformation,
            scoringVersion: LOCATION_SCORING_VERSION,
            isCurrent: true,
            updatedAt: new Date(),
          },
        }).returning();
        const [persisted] = saved
          ? [saved]
          : await db.select().from(locationRecommendationsTable).where(and(
            eq(locationRecommendationsTable.projectId, projectId),
            eq(locationRecommendationsTable.inventoryMediaUnitId, unit.id),
            eq(locationRecommendationsTable.matchingRadiusMeters, radiusMeters),
          ));
        const relationship = nearest ? relationships.find((entry) => entry.location.id === nearest.location.id) : null;
        responseRecommendations.push({
          id: persisted?.id,
          projectId,
          inventoryAssetId: asset.id,
          inventoryMediaUnitId: unit.id,
          assetCode: asset.assetCode,
          assetName: asset.assetName,
          latitude: asset.latitude,
          longitude: asset.longitude,
          unitType: unit.unitType,
          format: unit.format,
          distanceMeters: nearest?.distanceMeters ?? null,
          distanceLabel: nearest ? `${Math.round(nearest.distanceMeters)} m straight-line` : null,
          nearbyLocations: relationships
            .sort((a, b) => a.distanceMeters - b.distanceMeters)
            .map(({ location, distanceMeters: distance }) => ({
              id: location.id,
              role: location.role,
              name: location.name,
              category: location.category,
              distanceMeters: distance,
              distanceLabel: `${Math.round(distance)} m straight-line`,
            })),
          score: calculated.score,
          scoringVersion: LOCATION_SCORING_VERSION,
          components: calculated.components,
          explanation,
          missingInformation,
          decision: persisted?.decision ?? "UNREVIEWED",
          decisionReason: persisted?.decisionReason ?? null,
          isCurrent: persisted?.isCurrent ?? true,
          relationship,
        });
      }
    }
  }
  return {
    strategyStatus: strategy?.status ?? "DRAFT",
    approvedLocations,
    responseRecommendations,
    limitations,
  };
}

function normalized(value: unknown): string {
  return typeof value === "string" ? value.toLocaleLowerCase() : "";
}

export async function recommendBusRoutes(projectId: string, strategy: typeof projectLocationStrategiesTable.$inferSelect | undefined) {
  await db.update(locationRouteRecommendationsTable).set({
    isCurrent: false,
    updatedAt: new Date(),
  }).where(eq(locationRouteRecommendationsTable.projectId, projectId));
  const routeRows = await db.select({
    source: busRouteSourceRowsTable,
    route: busRoutesTable,
  }).from(busRouteSourceRowsTable)
    .innerJoin(busRoutesTable, eq(busRouteSourceRowsTable.busRouteId, busRoutesTable.id))
    .where(and(eq(busRouteSourceRowsTable.isActive, true), eq(busRoutesTable.isActive, true)));
  const [project] = await db.select({
    campaignGeography: pitchProjectsTable.campaignGeography,
    campaignAreas: pitchProjectsTable.campaignAreas,
  }).from(pitchProjectsTable).where(eq(pitchProjectsTable.id, projectId));
  const areas = strategy?.status === "APPROVED" ? strategy.targetAreas : [];
  const roads = strategy?.status === "APPROVED" ? strategy.targetRoads : [];
  const categoryTerms = strategy?.status === "APPROVED" ? strategy.categories.map(({ name }) => name) : [];
  const result = [];
  for (const { source, route } of routeRows) {
    const raw = source.rawData;
    const fields = Object.fromEntries(Object.entries(raw).map(([key, value]) =>
      [key.toLowerCase().replace(/[^a-z0-9]/g, ""), String(value ?? "")]));
    const get = (...keys: string[]) => {
      const key = keys.map((value) => value.toLowerCase().replace(/[^a-z0-9]/g, "")).find((value) => fields[value]?.trim());
      return key ? fields[key]!.trim() : null;
    };
    const from = get("Starting Station", "From");
    const to = get("Ending Station", "To");
    const via = get("Via");
    const depot = get("Depot", "Depot Name");
    const context = normalized([from, to, via].join(" "));
    const matches = [...areas, ...roads, ...categoryTerms].filter((term) => context.includes(normalized(term)));
    if (!matches.length) continue;
    if (!routeHasCampaignGeographyEvidence(
      [from, to, via].filter(Boolean).join(" "),
      project?.campaignGeography,
      project?.campaignAreas ?? [],
      areas,
    )) continue;
    if (source.allocatedBusCount !== null && source.allocatedBusCount <= 0) continue;
    const scale = strategy?.campaignScale ?? "BALANCED";
    const fraction = scale === "FOCUSED" ? 0.2 : scale === "HIGH_PRESENCE" ? 0.6 : 0.4;
    const count = source.allocatedBusCount;
    const suggestedQuantity = count === null
      ? 1
      : Math.max(1, Math.min(count, Math.round(count * fraction)));
    const explanation = [
      `Specific source variant ${source.sheetName}, row ${source.sourceRowNumber}; route variants remain separate.`,
      `Via/From/To matches approved strategy: ${matches.join(", ")}.`,
      `Route relevance score awards 20 points per distinct strategy term served (maximum 100): ${Math.min(100, matches.length * 20)}.`,
      count === null
        ? `Source count is unknown; quantity 1 is a conservative planning placeholder for ${scale}, not an availability claim.`
        : `Scale ${scale} uses ${Math.round(fraction * 100)}% of the reported route bus count as a planning heuristic.`,
      count === null ? "Source bus count is missing; quantity is a planning suggestion only." : `Source reports ${count} buses; this is not availability or reservation.`,
    ];
    const missingInformation = [
      "Operational availability and reservation status are not verified.",
      ...(count === null ? ["Source bus count is unavailable."] : []),
    ];
    const [persisted] = await db.insert(locationRouteRecommendationsTable).values({
      projectId,
      sourceVariantId: source.id,
      routeId: route.routeId,
      score: Math.min(100, matches.length * 20),
      suggestedQuantity,
      scoringVersion: "location-route-v1",
      explanation: { messages: explanation, sourceBusCount: count },
      missingInformation,
      isCurrent: true,
    }).onConflictDoUpdate({
      target: [
        locationRouteRecommendationsTable.projectId,
        locationRouteRecommendationsTable.sourceVariantId,
      ],
      set: {
        routeId: route.routeId,
        score: Math.min(100, matches.length * 20),
        suggestedQuantity,
        scoringVersion: "location-route-v1",
        explanation: { messages: explanation, sourceBusCount: count },
        missingInformation,
        isCurrent: true,
        updatedAt: new Date(),
      },
    }).returning();
    const [current] = persisted ? [persisted] : await db.select().from(locationRouteRecommendationsTable)
      .where(and(
        eq(locationRouteRecommendationsTable.projectId, projectId),
        eq(locationRouteRecommendationsTable.sourceVariantId, source.id),
      ));
    result.push({
      id: current?.id,
      routeId: route.routeId,
      sourceVariantId: source.id,
      from,
      to,
      via,
      depot,
      sourceBusCount: count,
      suggestedQuantity,
      quantityLabel: "AI_SUGGESTED_PLANNING_QUANTITY" as const,
      score: Math.min(100, matches.length * 20),
      scoringVersion: "location-route-v1",
      explanation,
      missingInformation,
      decision: current?.decision ?? "UNREVIEWED",
      isCurrent: current?.isCurrent ?? true,
    });
  }
  return result;
}