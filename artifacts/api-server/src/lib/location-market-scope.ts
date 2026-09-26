export type CampaignGeography = "DUBAI" | "ABU_DHABI" | "UAE" | "CUSTOM";
export type CampaignGeographyStatus =
  | "IN_CAMPAIGN_GEOGRAPHY"
  | "OUTSIDE_CAMPAIGN_GEOGRAPHY"
  | "UNVERIFIED_CAMPAIGN_GEOGRAPHY";

export interface LocationMarketEvidence {
  name: string | null;
  area: string | null;
  address: string | null;
}

export interface AssetMarketEvidence {
  area?: string | null;
  areaNormalized?: string | null;
  road?: string | null;
  roadNormalized?: string | null;
  emirate?: string | null;
  assetName?: string | null;
  stopName?: string | null;
}

function evidenceText(evidence: LocationMarketEvidence | AssetMarketEvidence): string {
  return Object.values(evidence)
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(" ");
}

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/[.,]/g, " ").replace(/\s+/g, " ");
}

function containsGeography(text: string, geography: "DUBAI" | "ABU_DHABI"): boolean {
  const pattern = geography === "DUBAI"
    ? /\bdubai\b/i
    : /\b(?:abu dhabi|reem mall|reem island|yas island|saadiyat island|al ain)\b/i;
  return pattern.test(text);
}

function containsOtherEmirate(text: string, geography: CampaignGeography): boolean {
  const emirateNames = ["abu dhabi", "dubai", "sharjah", "ajman", "umm al quwain", "ras al khaimah", "fujairah"];
  return emirateNames.some((name) =>
    name !== (geography === "ABU_DHABI" ? "abu dhabi" : geography.toLocaleLowerCase().replace("_", " ")) &&
    new RegExp(`\\b${name.replace(/ /g, "\\s+")}\\b`, "i").test(text));
}

function matchesAreaName(text: string, areas: string[]): boolean {
  const normalizedText = normalized(text);
  return areas.some((area) => {
    const candidate = normalized(area);
    return candidate.length > 0 && new RegExp(
      `(?:^|[^a-z0-9])${candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+")}(?:$|[^a-z0-9])`,
      "i",
    ).test(normalizedText);
  });
}

export function campaignGeographyStatus(
  location: LocationMarketEvidence,
  geography: CampaignGeography | null | undefined,
  campaignAreas: string[] = [],
): CampaignGeographyStatus {
  if (!geography) return "UNVERIFIED_CAMPAIGN_GEOGRAPHY";
  const text = evidenceText(location);

  if (geography === "CUSTOM") {
    if (matchesAreaName(text, campaignAreas)) return "IN_CAMPAIGN_GEOGRAPHY";
    return "UNVERIFIED_CAMPAIGN_GEOGRAPHY";
  }

  if (geography === "DUBAI" || geography === "ABU_DHABI") {
    const other = geography === "DUBAI" ? "ABU_DHABI" : "DUBAI";
    if (containsGeography(text, other)) return "OUTSIDE_CAMPAIGN_GEOGRAPHY";
    if (containsGeography(text, geography)) return "IN_CAMPAIGN_GEOGRAPHY";
    return "UNVERIFIED_CAMPAIGN_GEOGRAPHY";
  }

  if (/\b(?:uae|united arab emirates)\b/i.test(text) ||
      containsGeography(text, "DUBAI") || containsGeography(text, "ABU_DHABI") ||
      ["abu dhabi", "dubai", "sharjah", "ajman", "umm al quwain", "ras al khaimah", "fujairah"]
        .some((name) => new RegExp(`\\b${name.replace(/ /g, "\\s+")}\\b`, "i").test(text))) {
    return "IN_CAMPAIGN_GEOGRAPHY";
  }
  return "UNVERIFIED_CAMPAIGN_GEOGRAPHY";
}

export function filterLocationsToCampaignGeography<T extends LocationMarketEvidence>(
  locations: T[],
  geography: CampaignGeography | null | undefined,
  campaignAreas: string[] = [],
): T[] {
  return locations.filter((location) =>
    campaignGeographyStatus(location, geography, campaignAreas) === "IN_CAMPAIGN_GEOGRAPHY");
}

/**
 * SkyBlue bus-shelter inventory is Dubai-network inventory. Geography cannot
 * expand that network; a custom campaign must explicitly include the asset's area.
 */
export function isShelterInCampaignGeography(
  asset: AssetMarketEvidence,
  geography: CampaignGeography | null | undefined,
  campaignAreas: string[] = [],
): boolean {
  if (geography === "DUBAI" || geography === "UAE") return true;
  if (geography !== "CUSTOM") return false;
  return matchesAreaName(evidenceText(asset), campaignAreas);
}

/**
 * A route has no authoritative emirate field. It is usable only with positive
 * textual evidence for the campaign geography or a matching approved target area
 * that is explicitly included in a custom campaign.
 */
export function routeHasCampaignGeographyEvidence(
  routeText: string,
  geography: CampaignGeography | null | undefined,
  campaignAreas: string[] = [],
  approvedTargetAreas: string[] = [],
): boolean {
  if (!geography) return false;
  if (geography === "CUSTOM") {
    return campaignAreas.some((area) => {
      const routeMatches = matchesAreaName(routeText, [area]);
      const strategyMatches = approvedTargetAreas.some((target) => normalized(target) === normalized(area));
      return routeMatches && strategyMatches;
    });
  }
  if (geography === "DUBAI" && containsGeography(routeText, "ABU_DHABI")) return false;
  if (geography === "ABU_DHABI" && containsGeography(routeText, "DUBAI")) return false;
  if (geography === "DUBAI" && containsGeography(routeText, "DUBAI")) return true;
  if (geography === "ABU_DHABI" && containsGeography(routeText, "ABU_DHABI")) return true;
  if (geography === "UAE" && (/\b(?:uae|united arab emirates)\b/i.test(routeText) ||
      ["abu dhabi", "dubai", "sharjah", "ajman", "umm al quwain", "ras al khaimah", "fujairah"]
        .some((name) => new RegExp(`\\b${name.replace(/ /g, "\\s+")}\\b`, "i").test(routeText)) ||
      containsGeography(routeText, "ABU_DHABI"))) return true;
  if (containsOtherEmirate(routeText, geography)) return false;
  return approvedTargetAreas.some((area) => matchesAreaName(routeText, [area]));
}