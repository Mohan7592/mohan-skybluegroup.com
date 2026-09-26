export function validCoordinates(latitude: number | null, longitude: number | null): latitude is number {
  return latitude !== null && longitude !== null &&
    Number.isFinite(latitude) && Number.isFinite(longitude) &&
    latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180;
}

export function calculateLocationScore(components: Array<{
  criterion: string;
  points: number;
  maximum: number;
  explanation: string;
}>) {
  const availableMaximum = components.reduce((sum, component) => sum + component.maximum, 0);
  const score = availableMaximum === 0
    ? 0
    : Math.round(100 * components.reduce((sum, component) => sum + component.points, 0) / availableMaximum);
  return { score, components };
}

export function shouldRecommendForLocation(input: {
  hasNearbyPoi: boolean;
  matchesTargetArea: boolean;
  matchesTargetRoad: boolean;
}): boolean {
  return input.hasNearbyPoi || input.matchesTargetArea || input.matchesTargetRoad;
}

export function locationRecommendationEvidence(
  components: Array<{ criterion: string; points: number; maximum: number; explanation: string }>,
  nearestDistanceMeters: number | null,
) {
  return { components, distanceMeters: nearestDistanceMeters };
}

const GENERIC_POI_CATEGORIES = new Set([
  "amenity",
  "building",
  "commercial",
  "location",
  "office",
  "place",
  "shop",
  "tourism",
]);

function normalizedCategory(value: string): string {
  return value.toLocaleLowerCase().trim().replace(/[^a-z0-9]+/g, " ");
}

export function matchPoiCategoryPriority(
  poiCategory: string,
  strategyCategories: Array<{ name: string; priority: number }>,
): { category: string; priority: number } | null {
  const normalizedPoiCategory = normalizedCategory(poiCategory);
  if (!normalizedPoiCategory || GENERIC_POI_CATEGORIES.has(normalizedPoiCategory)) return null;
  const matches = strategyCategories.filter(({ name }) => {
    const normalizedStrategyCategory = normalizedCategory(name);
    return normalizedStrategyCategory === normalizedPoiCategory ||
      normalizedStrategyCategory.includes(` ${normalizedPoiCategory} `) ||
      normalizedStrategyCategory.startsWith(`${normalizedPoiCategory} `) ||
      normalizedStrategyCategory.endsWith(` ${normalizedPoiCategory}`);
  }).sort((a, b) => a.priority - b.priority);
  const selected = matches[0];
  return selected ? { category: selected.name, priority: selected.priority } : null;
}

export type LocationStrategyResearchClaim = {
  claim: string;
  category: string;
  status: string;
  isDemo: boolean;
  methodology: string | null;
  source: {
    title: string;
    url: string | null;
    publisher: string | null;
    publishedAt: Date | null;
    retrievedAt: Date | null;
  } | null;
};

export function verifiedAudienceSeed(
  claim: LocationStrategyResearchClaim,
  latestReview?: { decision: string; sourceQuote: string | null; quoteVerifiedAt: Date | null } | null,
): string | null {
  if (claim.isDemo || claim.status !== "approved" ||
      !/(^|\.)target_audience$|(^|\.)audience$/i.test(claim.category) ||
      !claim.source?.url || !claim.source.publisher || !claim.source.publishedAt || !claim.source.retrievedAt) {
    return null;
  }
  const extractedQuote = claim.methodology?.match(/^Source-exact excerpt:\s*[“"]([\s\S]+)[”"]\s*$/)?.[1]?.trim();
  const reviewQuote = latestReview?.decision === "approved" && latestReview.quoteVerifiedAt
    ? latestReview.sourceQuote?.trim()
    : null;
  const quote = reviewQuote || extractedQuote;
  if (!quote || quote.length < 20 || claim.source.url.length > 800 || quote.length > 700) return null;
  const claimText = claim.claim.trim().slice(0, 350);
  const publisher = claim.source.publisher.trim().slice(0, 160);
  const title = claim.source.title.trim().slice(0, 160);
  const audience = `Research-supported audience: ${claimText} [Source: ${publisher}, ${title}, ${claim.source.url}; verified quote: “${quote}”]`;
  return audience.length <= 2000 ? audience : null;
}

export function canRefreshDiscoveredProviderCandidate(
  existing: {
    role: string;
    provider: string | null;
    providerId: string | null;
    reviewStatus: string;
  },
  candidate: { role: string; provider: string; providerId: string },
): boolean {
  return existing.reviewStatus === "NEEDS_REVIEW" &&
    existing.role === candidate.role &&
    existing.provider === candidate.provider &&
    existing.providerId === candidate.providerId;
}

export function shouldClearProjectPoiLink(role: string, decision: string): boolean {
  return role === "POI" && decision !== "APPROVED";
}