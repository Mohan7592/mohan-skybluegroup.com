import type { PassengerEvidenceSummary } from "./passenger-metrics-analysis";
import type { CampaignGeography } from "./location-market-scope";

export type NetworkRouteSource = {
  sourceVariantId: string;
  routeId: string;
  from: string | null;
  to: string | null;
  via: string | null;
  depot: string | null;
  sourceSheet: string;
  sourceRow: number;
  sourceBusCount: number | null;
  isActive: boolean;
  isRejected?: boolean;
};

export type NetworkRecommendation = NetworkRouteSource & {
  proposedQuantity: number;
  matchedTargets: string[];
  rationale: string;
  quantityBasis: string;
  routePassengerEvidence?: RoutePassengerEvidenceView[];
  routePassengerSummary?: PassengerRouteSeriesSummary;
  reportedSourceBusCountShare?: number | null;
  evidenceSources: Array<"PASSENGER_EVIDENCE" | "GEOGRAPHY_FROM_TO_VIA" | "SOURCE_BUS_COUNT">;
  routeFamilyPassengerEvidence?: "ROUTE_LEVEL_ONLY";
  targetOverlapRatio: number;
};

export type RoutePassengerEvidence = {
  routeId: string;
  sourceVariantId: string;
  source: string;
  period: string;
  passengerCount: number;
  tripCount?: number | null;
  sourceRow?: number;
  importedAt?: string;
  summary?: PassengerRouteSeriesSummary;
};

export type PassengerRouteSeriesSummary = {
  latest: {
    period: string;
    passengerCount: number;
    tripCount: number | null;
    passengersPerTrip: number | null;
    sourceFile: string;
    sourceRow: number;
  } | null;
  previous: {
    period: string;
    passengerCount: number;
    tripCount: number | null;
    passengersPerTrip: number | null;
    sourceFile: string;
    sourceRow: number;
  } | null;
  firstPeriod: string | null;
  lastPeriod: string | null;
  threeMonthAverage: number | null;
  threeMonthPeriods: number;
  sixMonthAverage: number | null;
  sixMonthPeriods: number;
  availableTotal: number | null;
  availablePeriods: number;
  duplicatePeriods: number;
  conflictingPeriods: number;
  passengerPercentile: number | null;
  activity: "REPORTED_PASSENGER_ACTIVITY" | "NO_ACTIVITY_REPORTED" | "NO_METRIC";
};

export type RoutePassengerEvidenceView = RoutePassengerEvidence & {
  projectGeographyContext: string;
  evidenceType: "route-level passenger data";
};

export type RouteFamilyPassengerEvidence = {
  routeId: string;
  summary: Omit<PassengerEvidenceSummary, "latest" | "previous"> & {
    latest: Omit<NonNullable<PassengerEvidenceSummary["latest"]>, "sourceFile" | "sourceRow"> | null;
    previous: Omit<NonNullable<PassengerEvidenceSummary["previous"]>, "sourceFile" | "sourceRow"> | null;
  };
};

export type RouteFamilyPassengerEvidenceInput = {
  routeId: string;
  summary: PassengerEvidenceSummary;
};

export type NetworkRecommendationResult = {
  geography: string | null;
  geographyScope: "project context only; route operating geography unverified";
  targetBuses: number;
  proposedTotal: number;
  shortfall: number;
  recommendations: NetworkRecommendation[];
  passengerEvidenceCoverage: {
    supportedRecommendedVariants: number;
    recommendedVariants: number;
    label: string;
  };
  routeFamilyPassengerEvidence: RouteFamilyPassengerEvidence[];
  limitations: string[];
  routeLevelEvidence: {
    provider: "RTA passenger data";
    status: "available" | "unavailable";
    passengers: null;
    impressions: null;
    reach: null;
    note: string;
  };
};

type NetworkRecommendationInput = {
  geography: string | null;
  campaignAreas?: string[];
  targetBuses: number;
  targetAreas: string[];
  targetRoads: string[];
  objective?: string | null;
  strategyApproved: boolean;
  routes: NetworkRouteSource[];
  routePassengerEvidence?: RoutePassengerEvidence[];
  routeFamilyPassengerEvidence?: RouteFamilyPassengerEvidenceInput[];
};

const normalize = (value: string) => value.toLocaleLowerCase()
  .replace(/\bszr\b/g, "sheikh zayed road")
  .replace(/[^a-z0-9]+/g, " ").trim();

function campaignGeography(value: string | null): CampaignGeography | null {
  switch (normalize(value ?? "").replace(/ /g, "_")) {
    case "dubai":
    case "dubai_uae":
      return "DUBAI";
    case "abu_dhabi":
      return "ABU_DHABI";
    case "uae":
    case "united_arab_emirates":
      return "UAE";
    case "custom":
      return "CUSTOM";
    default:
      return null;
  }
}

function hasCampaignRouteEvidence(
  routeText: string,
  geography: CampaignGeography | null,
  campaignAreas: string[],
  approvedTargets: string[],
): boolean {
  if (!geography) return false;
  const context = normalize(routeText);
  const hasPhrase = (phrase: string) => containsTargetPhrase(context, normalize(phrase));
  const hasDubai = hasPhrase("Dubai");
  const hasAbuDhabi = hasPhrase("Abu Dhabi") || ["Reem Mall", "Reem Island", "Yas Island", "Saadiyat Island", "Al Ain"].some(hasPhrase);
  if (geography === "CUSTOM") {
    return campaignAreas.some((area) =>
      hasPhrase(area) && approvedTargets.some((target) => normalize(target) === normalize(area)));
  }
  if (geography === "DUBAI" && hasAbuDhabi) return false;
  if (geography === "ABU_DHABI" && hasDubai) return false;
  if (geography === "DUBAI" && hasDubai) return true;
  if (geography === "ABU_DHABI" && hasAbuDhabi) return true;
  if (geography === "UAE" && (hasPhrase("UAE") || hasPhrase("United Arab Emirates") ||
      ["Abu Dhabi", "Dubai", "Sharjah", "Ajman", "Umm Al Quwain", "Ras Al Khaimah", "Fujairah"]
        .some(hasPhrase) || hasAbuDhabi)) return true;
  const otherEmirates = ["Abu Dhabi", "Dubai", "Sharjah", "Ajman", "Umm Al Quwain", "Ras Al Khaimah", "Fujairah"]
    .filter((emirate) => !(geography === "ABU_DHABI" && emirate === "Abu Dhabi") &&
      !(geography === "DUBAI" && emirate === "Dubai"));
  if (otherEmirates.some(hasPhrase)) return false;
  return approvedTargets.some(hasPhrase);
}

const genericTargetTerms = new Set([
  "a", "at", "area", "areas", "arab", "central", "city", "country", "district", "east", "emirate",
  "emirates", "for", "in", "main", "market", "near", "north", "of", "on", "road", "roads", "route",
  "routes", "south", "street", "streets", "the", "to", "uae", "united", "west", "zone", "zones",
  "dubai",
]);

function specificTarget(target: string): string | null {
  const normalized = normalize(target);
  if (!normalized || normalized.length < 3) return null;
  const tokens = normalized.split(" ");
  if (tokens.every((token) => genericTargetTerms.has(token))) return null;
  return normalized;
}

function routeContext(route: NetworkRouteSource): string {
  return normalize([route.from, route.to, route.via].filter(Boolean).join(" "));
}

function containsTargetPhrase(context: string, target: string): boolean {
  return ` ${context} `.includes(` ${target} `);
}

function publicFamilySummary(summary: PassengerEvidenceSummary): RouteFamilyPassengerEvidence["summary"] {
  const stripRowReferences = <T extends { sourceFile: string; sourceRow: number }>(period: T | null) => {
    if (!period) return null;
    const { sourceFile: _sourceFile, sourceRow: _sourceRow, ...publicPeriod } = period;
    return publicPeriod;
  };
  return {
    ...summary,
    latest: stripRowReferences(summary.latest),
    previous: stripRowReferences(summary.previous),
  };
}

export function recommendNetworkRoutes(input: NetworkRecommendationInput): NetworkRecommendationResult {
  const geography = input.geography?.trim() || null;
  const limitations: string[] = [];
  const recommendations: NetworkRecommendation[] = [];

  if (!geography) {
    limitations.push("Project geography is not recorded; route recommendations cannot be geographically grounded.");
  }
  if (!input.strategyApproved) {
    limitations.push("No approved location strategy is available; draft strategy targets are not used.");
  }
  const objective = input.objective?.trim() || "unspecified";
  const targets = [...new Set([...input.targetAreas, ...input.targetRoads]
    .map((target) => target.trim()).filter(Boolean))];
  const specificTargets = targets.flatMap((target) => {
    const normalized = specificTarget(target);
    return normalized ? [{ label: target, normalized }] : [];
  });
  if (!targets.length) {
    limitations.push("The approved strategy has no target areas or roads to match against route From/To/Via.");
  } else if (!specificTargets.length) {
    limitations.push("Approved strategy targets contain only generic terms; no specific target names can be matched safely.");
  }
  limitations.push("Bus-route source rows provide no explicit operating-market evidence. Target-text matches are suggestive only; route operating geography remains unverified pending source confirmation.");

  if (geography && input.strategyApproved && specificTargets.length) {
    const matched = input.routes
      .filter((route) => route.isActive && !route.isRejected &&
        hasCampaignRouteEvidence(
          [route.from, route.to, route.via].filter(Boolean).join(" "),
          campaignGeography(geography),
          input.campaignAreas ?? [],
          [...input.targetAreas, ...input.targetRoads],
        ))
      .map((route) => {
        const context = routeContext(route);
        const matchedTargets = specificTargets
          .filter(({ normalized }) => containsTargetPhrase(context, normalized))
          .map(({ label }) => label);
        const passenger = (input.routePassengerEvidence ?? []).find((evidence) =>
          evidence.routeId === route.routeId &&
          evidence.sourceVariantId === route.sourceVariantId);
        const passengerPercentile = passenger?.summary?.passengerPercentile ?? null;
        const sourceScale = route.sourceBusCount === null ? 0 : Math.log1p(Math.max(0, route.sourceBusCount));
        const awarenessObjective = /brand|awareness|visibility|marketing/i.test(objective);
        const passengerWeight = awarenessObjective ? 1.5 : 0.75;
        const geographicOverlapRatio = specificTargets.length ? matchedTargets.length / specificTargets.length : 0;
        const priorityScore = matchedTargets.length * 10000 +
          geographicOverlapRatio * 500 +
          sourceScale * 10 +
          (passengerPercentile ?? 50) * passengerWeight;
        return { route, matchedTargets, passenger, geographicOverlapRatio, priorityScore };
      })
      .filter(({ matchedTargets }) => matchedTargets.length > 0)
      .sort((a, b) =>
        b.priorityScore - a.priorityScore ||
        b.matchedTargets.length - a.matchedTargets.length ||
        a.route.routeId.localeCompare(b.route.routeId) ||
        a.route.sourceSheet.localeCompare(b.route.sourceSheet) ||
        a.route.sourceRow - b.route.sourceRow ||
        a.route.sourceVariantId.localeCompare(b.route.sourceVariantId));

    if (!matched.length) {
      limitations.push("No active Bus Routes Master source variants match the approved target areas or roads with positive campaign-geography evidence.");
    } else {
      const selected = matched.slice(0, input.targetBuses);
      const recommendedFamilyIds = new Set(selected.map(({ route }) => route.routeId));
      const routeFamilyPassengerEvidence = (input.routeFamilyPassengerEvidence ?? [])
        .filter((evidence) =>
          recommendedFamilyIds.has(evidence.routeId) &&
          evidence.summary.mappingStatus === "ROUTE_LEVEL_ONLY");
      const totalReportedSourceBusCount = matched.reduce((total, { route }) =>
        total + (route.sourceBusCount !== null ? Math.max(0, route.sourceBusCount) : 0), 0);
      const baseQuantity = Math.floor(input.targetBuses / selected.length);
      const remainder = input.targetBuses % selected.length;
      selected.forEach(({ route, matchedTargets, passenger, geographicOverlapRatio }, index) => {
        const proposedQuantity = baseQuantity + (index < remainder ? 1 : 0);
        const passengerEvidence = (passenger ? [passenger] : [])
          .filter((evidence) =>
            evidence.routeId === route.routeId &&
            evidence.sourceVariantId === route.sourceVariantId &&
            evidence.source.trim().length > 0 &&
            evidence.period.trim().length > 0 &&
            Number.isSafeInteger(evidence.passengerCount) &&
            evidence.passengerCount >= 0)
          .map((evidence): RoutePassengerEvidenceView => ({
            ...evidence,
            source: evidence.source.trim(),
            period: evidence.period.trim(),
            projectGeographyContext: geography,
            evidenceType: "route-level passenger data",
          }))
          .sort((a, b) =>
            a.period.localeCompare(b.period) ||
            a.source.localeCompare(b.source) ||
            a.passengerCount - b.passengerCount);
        recommendations.push({
          ...route,
          proposedQuantity,
          matchedTargets,
          targetOverlapRatio: geographicOverlapRatio,
          reportedSourceBusCountShare: route.sourceBusCount !== null && totalReportedSourceBusCount > 0
            ? route.sourceBusCount / totalReportedSourceBusCount : null,
          evidenceSources: [
            ...(passengerEvidence.length ? ["PASSENGER_EVIDENCE" as const] : []),
            ...(matchedTargets.length ? ["GEOGRAPHY_FROM_TO_VIA" as const] : []),
            ...(route.sourceBusCount !== null ? ["SOURCE_BUS_COUNT" as const] : []),
          ],
          ...(routeFamilyPassengerEvidence.some((evidence) => evidence.routeId === route.routeId)
            ? { routeFamilyPassengerEvidence: "ROUTE_LEVEL_ONLY" as const } : {}),
          ...(passenger?.summary ? { routePassengerSummary: passenger.summary } : {}),
          rationale: `Planning order considers approved-target text overlap in From/To/Via, reported source bus-count scale and ${objective} objective context. ${passenger?.summary?.latest ? `Matched source passenger counts are available for ${passenger.summary.availablePeriods} distinct month(s); percentile is only a comparison of same-period route records.` : "No variant-specific matched passenger data is available."} Target-text overlap is suggestive only; the source does not confirm route operating geography or campaign performance.`,
          quantityBasis: "Requested quantity is a planning allocation; reported source bus counts provide scale context only, not fleet share, availability, reservations or identifiable vehicles.",
          ...(passengerEvidence.length ? { routePassengerEvidence: passengerEvidence } : {}),
        });
      });
      if (matched.length < input.targetBuses) {
        limitations.push(`Only ${matched.length} matching active route source variant(s) are available; the recommendation mix is limited to those variants.`);
      }
    }
  }

  if (input.routes.some((route) => route.sourceBusCount !== null)) {
    limitations.push("Source bus counts are reported route-level counts, not confirmed availability, reservations, or identifiable vehicles.");
  } else {
    limitations.push("No source route bus counts are available; proposed quantities remain planning allocations only.");
  }
  const proposedTotal = recommendations.reduce((total, route) => total + route.proposedQuantity, 0);
  const routePassengerRecords = recommendations.flatMap((route) => route.routePassengerEvidence ?? []);
  const recommendedFamilyIds = new Set(recommendations.map(({ routeId }) => routeId));
  const routeFamilyPassengerRecords = (input.routeFamilyPassengerEvidence ?? [])
    .filter((evidence) =>
      recommendedFamilyIds.has(evidence.routeId) &&
      evidence.summary.mappingStatus === "ROUTE_LEVEL_ONLY");
  const publicRouteFamilyPassengerRecords = routeFamilyPassengerRecords.map(({ summary, ...evidence }) => ({
    ...evidence,
    summary: publicFamilySummary(summary),
  }));
  const supportedRecommendedVariants = new Set(recommendations
    .filter((route) => route.routePassengerEvidence?.length)
    .map((route) => route.sourceVariantId)).size;
  const passengerEvidenceCoverage = {
    supportedRecommendedVariants,
    recommendedVariants: recommendations.length,
    label: `Passenger-supported recommended variants: ${supportedRecommendedVariants} of ${recommendations.length}`,
  };
  if (!routePassengerRecords.length && !routeFamilyPassengerRecords.length) {
    limitations.push("No verified matched passenger metrics were supplied for the proposed route variants; passenger volumes, impressions, and reach are unavailable.");
  } else {
    limitations.push("Passenger counts are route-family or variant-specific transit ridership evidence, not campaign impressions, audience reach, or vehicle availability. Route-family-only counts do not support individual variant rankings.");
  }
  const passengerEvidenceAvailable = routePassengerRecords.length > 0 || routeFamilyPassengerRecords.length > 0;
  return {
    geography,
    geographyScope: "project context only; route operating geography unverified",
    targetBuses: input.targetBuses,
    proposedTotal,
    shortfall: Math.max(0, input.targetBuses - proposedTotal),
    recommendations,
    passengerEvidenceCoverage,
    routeFamilyPassengerEvidence: publicRouteFamilyPassengerRecords,
    limitations,
    routeLevelEvidence: {
      provider: "RTA passenger data",
      status: passengerEvidenceAvailable ? "available" : "unavailable",
      passengers: null,
      impressions: null,
      reach: null,
      note: passengerEvidenceAvailable
        ? "Variant-specific passenger evidence is shown only where a source variant is unambiguous. Route-family-only metrics are reported once at family level and are not copied to variants. The source file was user-provided and its external provenance has not been independently verified. No impression, reach or vehicle availability estimate is derived."
        : "No safely matched passenger-journey evidence is available for these proposed variants. No passenger volumes, impressions or audience reach are inferred.",
    },
  };
}