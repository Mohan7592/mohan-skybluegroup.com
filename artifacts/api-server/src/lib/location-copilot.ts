import { and, eq, inArray } from "drizzle-orm";
import {
  assetPoiRelationshipsTable,
  busRouteSourceRowsTable,
  busRoutesTable,
  db,
  inventoryAssetsTable,
  inventoryMediaUnitsTable,
  locationRecommendationsTable,
  locationRouteRecommendationsTable,
  pitchProjectsTable,
  projectInventorySelectionsTable,
  projectLocationStrategiesTable,
  projectLocationsTable,
} from "@workspace/db";

const normalized = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export function isLocationCopilotQuestion(question: string): boolean {
  if (/\b(?:add|include|put)\s+route\s+[a-z0-9-]+.*?\b\d+\s+(?:proposed\s+)?buses?\b/i.test(question)) return false;
  return /\b(?:where should we focus|location strategy|location recommendations?|recommended shelter|why (?:did you|was|is).{0,30}recommend|nearby.{0,25}shelters?|shelters?.{0,30}within\s+\d+\s*(?:m|meters?|km|kilometers?)|(?:approved\s+)?poi.{0,35}shelters?.{0,35}within|within\s+\d+\s*(?:m|meters?|km|kilometers?).{0,35}(?:poi|location|shelter)|competitor[- ]nearby|competitors?.{0,30}shelters?|target areas?.{0,30}routes?|routes?.{0,30}target areas?|focused bus plan|focus(?:ed)? bus(?:es)? plan|digital top panels?|add.{0,40}shelters?.{0,30}shortlist|shortlist.{0,30}shelters?|what (?:information|data) is missing|missing before.{0,20}(?:present|plan))\b/i.test(question);
}

function explicitRadius(question: string): number | null {
  const match = question.match(/\bwithin\s+(\d+(?:\.\d+)?)\s*(m|meters?|km|kilometers?)\b/i);
  if (!match) return null;
  return Number(match[1]) * (/^k/i.test(match[2]) ? 1000 : 1);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

export function isCurrentRecommendation(recommendation: unknown): boolean {
  return record(recommendation).isCurrent === true;
}

export function canShortlistLocationRecommendation(item: {
  recommendation: { isCurrent?: boolean; decision: string };
  asset: {
    isActive: boolean;
    sourceLifecycleStatus: string;
    assetType: string;
    syncReviewReasons: string[];
  };
  unit: { lifecycleStatus: string };
}): boolean {
  return isCurrentRecommendation(item.recommendation) &&
    item.recommendation.decision !== "REJECTED" &&
    item.asset.isActive &&
    item.asset.sourceLifecycleStatus === "ACTIVE" &&
    item.asset.assetType === "Bus Shelter" &&
    item.asset.syncReviewReasons.length === 0 &&
    item.unit.lifecycleStatus === "ACTIVE";
}

export function isAreaOnlyLocationRecommendation(recommendation: {
  reasons: string[];
  explanation: unknown;
}): boolean {
  const details = record(recommendation.explanation);
  return details.distanceMeters == null &&
    recommendation.reasons.some((reason) => /approved target (?:area|road)|target-area\/road strategy/i.test(reason));
}

function componentsText(value: unknown): string {
  const explanation = record(value);
  const components = Array.isArray(explanation.components) ? explanation.components : [];
  return components.map((entry) => {
    const component = record(entry);
    return `${String(component.criterion ?? "Scoring component")}: ${String(component.points ?? "?")}/${String(component.maximum ?? "?")} points — ${String(component.explanation ?? "No component explanation stored.")}`;
  }).join("; ") || "No scoring components were saved.";
}

function formatSource(label: string, url: string | null | undefined, status: string): string {
  return `${label}: ${url || "source URL not recorded"}; review status: ${status}.`;
}

function sourceCode(question: string): string | null {
  return question.match(/\b(?:shelter|asset)\s+([a-z0-9]+(?:-[a-z0-9]+)*)\b/i)?.[1]?.toUpperCase() ?? null;
}

function formatRecommendation(item: {
  assetCode: string;
  assetName: string | null;
  area: string | null;
  unitType: string;
  format: string;
  decision: string;
  fitScore: number | null;
  matchingRadiusMeters: number;
  explanation: unknown;
  assetSource: string | null;
  poiName: string;
  poiCategory: string;
  poiDistance: number;
  poiSource: string | null;
  poiReviewStatus: string;
}): string {
  const details = record(item.explanation);
  const distance = typeof details.distanceMeters === "number" ? details.distanceMeters : item.poiDistance;
  return `• ${item.assetCode}${item.assetName ? ` — ${item.assetName}` : ""}; ${item.area || "area not recorded"}; ${item.format} ${item.unitType}; ${item.fitScore ?? "score not saved"}/100; recommendation decision ${item.decision}; ${item.poiDistance} m straight-line from approved ${item.poiCategory} “${item.poiName}” (saved matching radius ${item.matchingRadiusMeters} m; recommendation's saved nearest distance ${distance} m); score components: ${componentsText(item.explanation)}\n  ${formatSource("Shelter source", item.assetSource, "inventory recommendation eligible (no sync-review flags)")}\n  ${formatSource(`Nearby-location source (${item.poiName})`, item.poiSource, item.poiReviewStatus)}`;
}

function missingPlanMessage(strategyStatus: string | undefined, approvedLocations: number): string | null {
  if (strategyStatus !== "APPROVED") {
    return "There is no approved location strategy for this project yet. Draft and approve the location strategy first; Copilot will then use its saved target areas, roads, categories, scale, and preferred formats. No locations or recommendations were inferred.";
  }
  if (!approvedLocations) {
    return "No approved project locations are saved yet. Add the relevant client, competitor, or POI locations, review and approve them, then generate location recommendations. Unreviewed provider results are not treated as verified locations.";
  }
  return null;
}

async function answerShortlistRequest(projectId: string, question: string): Promise<string> {
  const requestedCodes = [...new Set([...question.matchAll(/\b(?:shelter|asset)\s+([a-z0-9]+(?:-[a-z0-9]+)*)\b/gi)]
    .map((match) => match[1]!.toUpperCase()))];
  if (!requestedCodes.length) {
    return "No shelters were shortlisted. Please name each exact shelter code (for example, “Add Shelter 457A to shortlist”); where a shelter has multiple recommended media units, specify the unit too.";
  }
  const strategyRows = await db.select({ status: projectLocationStrategiesTable.status })
    .from(projectLocationStrategiesTable).where(eq(projectLocationStrategiesTable.projectId, projectId)).limit(1);
  const strategyStatus = strategyRows[0]?.status;
  if (strategyStatus !== "APPROVED") return `${missingPlanMessage(strategyStatus, 0)} No shelters were shortlisted.`;
  const approvedLocations = await db.select({ id: projectLocationsTable.id })
    .from(projectLocationsTable).where(and(
      eq(projectLocationsTable.projectId, projectId),
      eq(projectLocationsTable.reviewStatus, "APPROVED"),
    ));
  if (!approvedLocations.length) return `${missingPlanMessage(strategyStatus, 0)} No shelters were shortlisted.`;

  const recommendations = await db.select({
    recommendation: locationRecommendationsTable,
    asset: inventoryAssetsTable,
    unit: inventoryMediaUnitsTable,
  }).from(locationRecommendationsTable)
    .innerJoin(inventoryAssetsTable, eq(locationRecommendationsTable.inventoryAssetId, inventoryAssetsTable.id))
    .innerJoin(inventoryMediaUnitsTable, eq(locationRecommendationsTable.inventoryMediaUnitId, inventoryMediaUnitsTable.id))
    .where(and(
      eq(locationRecommendationsTable.projectId, projectId),
      eq(inventoryAssetsTable.isActive, true),
      eq(inventoryAssetsTable.sourceLifecycleStatus, "ACTIVE"),
      eq(inventoryMediaUnitsTable.lifecycleStatus, "ACTIVE"),
    ))
    .then((rows) => rows.filter(({ recommendation, asset }) =>
      isCurrentRecommendation(recommendation) && asset.syncReviewReasons.length === 0));
  const resolved: Array<{
    assetId: string;
    unitId: string;
    code: string;
    unitType: string;
    format: string;
    sourceUrl: string | null;
    score: number | null;
    explanation: unknown;
    decision: string;
  }> = [];
  const problems: string[] = [];
  for (const code of requestedCodes) {
    const matchingAssets = recommendations.filter(({ asset }) => asset.assetCode.toUpperCase() === code);
    if (!matchingAssets.length) {
      problems.push(`Shelter ${code} has no active, saved location recommendation in this project.`);
      continue;
    }
    const eligibleAssets = matchingAssets.filter(canShortlistLocationRecommendation);
    if (!eligibleAssets.length) {
      problems.push(`Shelter ${code} has no current, eligible, non-rejected recommendation to shortlist.`);
      continue;
    }
    const uniqueUnits = eligibleAssets.filter((entry, index, all) =>
      all.findIndex((candidate) => candidate.unit.id === entry.unit.id) === index);
    if (uniqueUnits.length !== 1) {
      problems.push(`Shelter ${code} has ${uniqueUnits.length} recommended media-unit choices: ${uniqueUnits.map(({ unit }) => `${unit.format} ${unit.unitType}`).join(", ")}. Specify one unit.`);
      continue;
    }
    const { asset, unit } = uniqueUnits[0]!;
    resolved.push({
      assetId: asset.id,
      unitId: unit.id,
      code,
      unitType: unit.unitType,
      format: unit.format,
      sourceUrl: asset.sourceMapLink ?? asset.mapUrl,
      score: uniqueUnits[0]!.recommendation.fitScore,
      explanation: uniqueUnits[0]!.recommendation.explanation,
      decision: uniqueUnits[0]!.recommendation.decision,
    });
  }
  if (problems.length) return `No shelters were shortlisted because the request needs clarification:\n${problems.map((item) => `• ${item}`).join("\n")}`;
  const [project] = await db.select({ id: pitchProjectsTable.id }).from(pitchProjectsTable)
    .where(eq(pitchProjectsTable.id, projectId)).limit(1);
  if (!project) return "This project no longer exists. No shelters were shortlisted.";
  await db.transaction(async (tx) => {
    for (const item of resolved) {
      await tx.insert(projectInventorySelectionsTable).values({
        projectId,
        inventoryAssetId: item.assetId,
        inventoryMediaUnitId: item.unitId,
        status: "shortlist",
        note: "Added by explicit Project Copilot shortlist request.",
      }).onConflictDoUpdate({
        target: [projectInventorySelectionsTable.projectId, projectInventorySelectionsTable.inventoryMediaUnitId],
        set: { status: "shortlist", note: "Added by explicit Project Copilot shortlist request.", updatedAt: new Date() },
      });
    }
  });
  return `Shortlisted ${resolved.map((item) =>
    `Shelter ${item.code} (${item.format} ${item.unitType}) for this project; saved score ${item.score ?? "not recorded"}/100; recommendation decision ${item.decision}; score components: ${componentsText(item.explanation)}; ${formatSource("Shelter source", item.sourceUrl, "inventory recommendation eligible (no sync-review flags)")}`).join("\n")}`;
}

export async function answerLocationQuestion(projectId: string, question: string): Promise<string | null> {
  if (!isLocationCopilotQuestion(question)) return null;

  if (/\b(?:add|include|put)\b/i.test(question) && /\bshortlist\b/i.test(question)) {
    return answerShortlistRequest(projectId, question);
  }

  const [strategy] = await db.select().from(projectLocationStrategiesTable)
    .where(eq(projectLocationStrategiesTable.projectId, projectId)).limit(1);
  const approvedLocations = await db.select().from(projectLocationsTable)
    .where(and(eq(projectLocationsTable.projectId, projectId), eq(projectLocationsTable.reviewStatus, "APPROVED")));
  const needsPlan = missingPlanMessage(strategy?.status, approvedLocations.length);
  if (/\bwhat (?:information|data) is missing|missing before.{0,20}(?:present|plan)\b/i.test(question)) {
    const gaps = new Set<string>();
    if (!strategy || strategy.status !== "APPROVED") gaps.add("approved location strategy (target areas/roads, categories, campaign scale, and preferred formats)");
    if (!approvedLocations.length) gaps.add("approved, coordinate-backed client/competitor/POI locations and their source URLs");
    const recommendations = await db.select().from(locationRecommendationsTable)
      .where(eq(locationRecommendationsTable.projectId, projectId));
    recommendations.filter(isCurrentRecommendation)
      .flatMap((recommendation) => recommendation.missingInformation).forEach((item) => gaps.add(item));
    gaps.add("operational shelter/media-unit availability or booking confirmation (empty client fields are not availability)");
    gaps.add("audience volume, traffic, impressions, and reach");
    return `Information gaps recorded for this project's saved location plan:\n${[...gaps].map((item) => `• ${item}`).join("\n")}${needsPlan ? `\n\nNext step: ${needsPlan}` : ""}`;
  }
  if (needsPlan) return needsPlan;

  if (/\b(?:which|what|show)\s+routes?.{0,35}\b(?:target areas?|coverage)\b|\btarget areas?.{0,35}\broutes?\b|\bfocused bus plan\b|\bfocus(?:ed)? bus(?:es)? plan\b/i.test(question)) {
    const routeRows = await db.select({
      recommendation: locationRouteRecommendationsTable,
      source: busRouteSourceRowsTable,
      route: busRoutesTable,
    }).from(locationRouteRecommendationsTable)
      .innerJoin(busRouteSourceRowsTable, eq(locationRouteRecommendationsTable.sourceVariantId, busRouteSourceRowsTable.id))
      .innerJoin(busRoutesTable, eq(busRouteSourceRowsTable.busRouteId, busRoutesTable.id))
      .where(and(
        eq(locationRouteRecommendationsTable.projectId, projectId),
        eq(busRouteSourceRowsTable.isActive, true),
        eq(busRoutesTable.isActive, true),
      ));
    const currentRouteRows = routeRows.filter(({ recommendation }) => isCurrentRecommendation(recommendation));
    if (!currentRouteRows.length) return "No current saved route recommendations match the approved target areas, roads, or categories. Use the Location Intelligence workflow to generate route recommendations from the approved strategy and active bus-route source.";
    const focused = /\bfocused\b/i.test(question);
    const rows = currentRouteRows.sort((a, b) => b.recommendation.score - a.recommendation.score ||
      a.route.routeId.localeCompare(b.route.routeId) ||
      a.source.sourceRowNumber - b.source.sourceRowNumber).slice(0, focused ? 5 : 20);
    return `${focused ? "Focused bus-plan candidates" : "Saved bus-route coverage recommendations"}:\n${rows.map(({ recommendation, source, route }) => {
      const details = record(recommendation.explanation);
      const messages = Array.isArray(details.messages) ? details.messages.map(String).join(" ") : "No route explanation saved.";
      return `• Route ${route.routeId} — ${String(source.rawData["Depot Name"] ?? "depot not supplied")}, ${source.sheetName.trim()} row ${source.sourceRowNumber}; score ${recommendation.score}/100; ${recommendation.suggestedQuantity} suggested buses (planning heuristic, not reserved); source count ${source.allocatedBusCount ?? "not supplied"}; recommendation decision ${recommendation.decision}. ${messages}\n  Bus-route source URL: not recorded on the saved route source row; active source ${source.sheetName.trim()} row ${source.sourceRowNumber}.`;
    }).join("\n")}\nThese are saved strategy-based suggestions, not availability, reservations, or confirmed coverage.`;
  }

  const wantsCompetitors = /\bcompetitor[- ]nearby|competitors?.{0,30}shelters?\b/i.test(question);
  const code = sourceCode(question);
  const radius = explicitRadius(question);
  if (radius !== null && (radius <= 0 || radius > 200000)) return "Please provide a distance greater than zero and no more than 200 km.";
  const matchingRadius = radius;
  const filterDigitalTop = /\bdigital\s+top\s+panels?\b/i.test(question);
  const poiSearch = wantsCompetitors ? null :
    question.match(/\b(?:of|near|around)\s+(.+?)(?:\s+within\b|\?|$)/i)?.[1]?.trim()
      .replace(/\b(?:relevant\s+)?locations?\b/gi, "").trim();
  const relevantLocations = approvedLocations.filter((location) =>
    wantsCompetitors ? location.role === "COMPETITOR" :
      code ? true : location.role === "POI");
  const requestedLocations = poiSearch
    ? relevantLocations.filter((location) => {
      const terms = normalized(poiSearch).split(/\s+/).filter((term) => term.length > 2);
      const place = normalized(`${location.name} ${location.category} ${location.brand ?? ""}`);
      return terms.some((term) => place.includes(term));
    })
    : relevantLocations;
  const relations = requestedLocations.length ? await db.select({
    relationship: assetPoiRelationshipsTable,
    location: projectLocationsTable,
  }).from(assetPoiRelationshipsTable)
    .innerJoin(projectLocationsTable, eq(assetPoiRelationshipsTable.poiId, projectLocationsTable.id))
    .where(and(
      eq(assetPoiRelationshipsTable.projectId, projectId),
      ...(matchingRadius === null ? [] : [eq(assetPoiRelationshipsTable.radiusMeters, matchingRadius)]),
      ...(code && !wantsCompetitors
        ? [inArray(assetPoiRelationshipsTable.relationshipType, ["CLIENT", "COMPETITOR", "POI"] as const)]
        : [eq(assetPoiRelationshipsTable.relationshipType, wantsCompetitors ? "COMPETITOR" : "POI")]),
      eq(projectLocationsTable.reviewStatus, "APPROVED"),
      ...(code && !wantsCompetitors
        ? []
        : [wantsCompetitors ? eq(projectLocationsTable.role, "COMPETITOR") : eq(projectLocationsTable.role, "POI")]),
      inArray(projectLocationsTable.id, requestedLocations.map((item) => item.id)),
    ))
  : [];
  const recommendationRows = await db.select({
    recommendation: locationRecommendationsTable,
    asset: inventoryAssetsTable,
    unit: inventoryMediaUnitsTable,
  }).from(locationRecommendationsTable)
    .innerJoin(inventoryAssetsTable, eq(locationRecommendationsTable.inventoryAssetId, inventoryAssetsTable.id))
    .innerJoin(inventoryMediaUnitsTable, eq(locationRecommendationsTable.inventoryMediaUnitId, inventoryMediaUnitsTable.id))
    .where(and(
      eq(locationRecommendationsTable.projectId, projectId),
      ...(matchingRadius === null ? [] : [eq(locationRecommendationsTable.matchingRadiusMeters, matchingRadius)]),
      eq(inventoryAssetsTable.isActive, true),
      eq(inventoryAssetsTable.sourceLifecycleStatus, "ACTIVE"),
      eq(inventoryMediaUnitsTable.lifecycleStatus, "ACTIVE"),
    ))
    .then((rows) => rows.filter(({ recommendation, asset }) =>
      isCurrentRecommendation(recommendation) && asset.syncReviewReasons.length === 0 &&
      asset.isActive && asset.sourceLifecycleStatus === "ACTIVE" && asset.assetType === "Bus Shelter"));
  const relationByAssetAndRadius = new Map<string, typeof relations>();
  for (const relation of relations) {
    const key = `${relation.relationship.inventoryAssetId}:${relation.relationship.radiusMeters}`;
    relationByAssetAndRadius.set(key, [...(relationByAssetAndRadius.get(key) ?? []), relation]);
  }
  let matches = recommendationRows.filter(({ recommendation, asset, unit }) => {
    if (code && asset.assetCode.toUpperCase() !== code) return false;
    if (filterDigitalTop && !(unit.unitType === "TOP_PANEL" && unit.format === "DIGITAL")) return false;
    return (relationByAssetAndRadius.get(`${asset.id}:${recommendation.matchingRadiusMeters}`) ?? []).length > 0;
  }).flatMap(({ recommendation, asset, unit }) =>
    (relationByAssetAndRadius.get(`${asset.id}:${recommendation.matchingRadiusMeters}`) ?? []).map(({ relationship, location }) => ({
      assetCode: asset.assetCode,
      assetName: asset.assetName,
      area: recommendation.area,
      unitType: unit.unitType,
      format: unit.format,
      decision: recommendation.decision,
      fitScore: recommendation.fitScore,
      matchingRadiusMeters: recommendation.matchingRadiusMeters,
      explanation: recommendation.explanation,
      assetSource: asset.sourceMapLink ?? asset.mapUrl,
      poiName: location.name,
      poiCategory: location.category,
      poiDistance: relationship.distanceMeters,
      poiSource: location.sourceUrl,
      poiReviewStatus: location.reviewStatus,
    })));
  const broadFocusQuestion = /\bwhere should we focus\b|\blocation recommendations?\b/i.test(question) ||
    (filterDigitalTop && !code && !wantsCompetitors && matchingRadius === null && !poiSearch);
  const areaOnlyRows = broadFocusQuestion
    ? recommendationRows.filter(({ recommendation, asset, unit }) => {
      if (code && asset.assetCode.toUpperCase() !== code) return false;
      if (filterDigitalTop && !(unit.unitType === "TOP_PANEL" && unit.format === "DIGITAL")) return false;
      return isAreaOnlyLocationRecommendation(recommendation);
    }).map(({ recommendation, asset, unit }) => ({
      recommendation,
      asset,
      unit,
    }))
    : [];
  if (code && !matches.length && !wantsCompetitors && !areaOnlyRows.length) {
    const codeRecommendations = recommendationRows.filter(({ asset, unit }) =>
      asset.assetCode.toUpperCase() === code &&
      (!filterDigitalTop || unit.unitType === "TOP_PANEL" && unit.format === "DIGITAL"));
    const uniqueUnits = codeRecommendations.filter((entry, index, all) =>
      all.findIndex((candidate) => candidate.unit.id === entry.unit.id) === index);
    if (uniqueUnits.length > 1) {
      return `Shelter ${code} has multiple saved recommended media units (${uniqueUnits.map(({ unit }) => `${unit.format} ${unit.unitType}`).join(", ")}). Please specify the exact unit for a unit-specific explanation.`;
    }
    if (uniqueUnits.length === 1) {
      const { recommendation, asset, unit } = uniqueUnits[0]!;
      const explanation = record(recommendation.explanation);
      const distance = typeof explanation.distanceMeters === "number"
        ? `${explanation.distanceMeters} m straight-line`
        : "no nearby-location distance saved";
      const locationSources = approvedLocations.map((location) =>
        formatSource(`Approved location (${location.role}: ${location.name})`, location.sourceUrl, location.reviewStatus));
      return `Shelter ${code} (${unit.format} ${unit.unitType}) has a saved recommendation at ${recommendation.matchingRadiusMeters} m: score ${recommendation.fitScore ?? "not recorded"}/100; decision ${recommendation.decision}; nearest distance ${distance}; saved rationale: ${recommendation.reasons.join(" ")}; scoring components: ${componentsText(recommendation.explanation)}.\n${formatSource("Shelter source", asset.sourceMapLink ?? asset.mapUrl, "inventory recommendation eligible (no sync-review flags)")}${locationSources.length ? `\n${locationSources.join("\n")}` : "\nNo approved location source URLs are recorded for this project."}`;
    }
    return `No saved location recommendation matches Shelter ${code}${matchingRadius === null ? "" : ` at ${matchingRadius} m`} under the requested filters. No match was inferred from inventory alone.`;
  }
  if (code && !matches.length && !areaOnlyRows.length) return `No saved competitor-nearby recommendation matches Shelter ${code}.`;
  if (!matches.length && !areaOnlyRows.length) {
    const qualifier = wantsCompetitors ? "approved competitor" : poiSearch ? "requested approved POI" : "approved POI";
    return `No saved shelter recommendation and project relationship records match an approved ${qualifier}${matchingRadius === null ? "" : ` within ${matchingRadius} m`}${filterDigitalTop ? " for active digital top panels" : ""}. Generate/review recommendations in Location Intelligence; this is not proof that no shelters exist.`;
  }
  matches = matches.sort((a, b) => a.fitScore === null ? 1 : b.fitScore === null ? -1 : b.fitScore - a.fitScore ||
    a.poiDistance - b.poiDistance || a.assetCode.localeCompare(b.assetCode));
  if (code && matches.length > 1) {
    const unitChoices = [...new Set(matches.map((item) => `${item.format} ${item.unitType}`))];
    if (unitChoices.length > 1) return `Shelter ${code} has multiple saved recommended media units (${unitChoices.join(", ")}). Please specify the exact unit for a unit-specific explanation.`;
  }
  const limited = matches.slice(0, 20);
  const areaReports = areaOnlyRows.slice(0, Math.max(0, 20 - limited.length)).map(({ recommendation, asset, unit }) =>
    `• ${asset.assetCode}${asset.assetName ? ` — ${asset.assetName}` : ""}; ${recommendation.area || "area not recorded"}; ${unit.format} ${unit.unitType}; ${recommendation.fitScore ?? "score not saved"}/100; recommendation decision ${recommendation.decision}; saved matching radius ${recommendation.matchingRadiusMeters} m. Area/road-only evidence: ${recommendation.reasons.join(" ")} No approved nearby-POI proximity is saved for this recommendation. Score components: ${componentsText(recommendation.explanation)}\n  ${formatSource("Shelter source", asset.sourceMapLink ?? asset.mapUrl, "inventory recommendation eligible (no sync-review flags)")}`);
  const sections = [
    limited.length
      ? `Saved ${wantsCompetitors ? "competitor-nearby" : "approved-POI-nearby"} shelter recommendations${matchingRadius === null ? "" : ` within ${matchingRadius} m`}${filterDigitalTop ? " (digital top panels only)" : ""}${code ? ` for Shelter ${code}` : ""} (${matches.length}):\n${limited.map(formatRecommendation).join("\n")}${matches.length > limited.length ? `\n…and ${matches.length - limited.length} more.` : ""}`
      : "",
    areaReports.length
      ? `Area/road-only recommendations without POI proximity (${areaOnlyRows.length}):\n${areaReports.join("\n")}${areaOnlyRows.length > areaReports.length ? `\n…and ${areaOnlyRows.length - areaReports.length} more.` : ""}`
      : "",
  ].filter(Boolean);
  return `${sections.join("\n\n")}\nDistances are straight-line, not walking or driving. Recommendations are not bookings; availability is not inferred from empty client fields.`;
}