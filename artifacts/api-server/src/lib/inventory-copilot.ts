export interface InventoryAnswerAsset {
  assetId: string;
  assetType: string;
  assetName: string | null;
  area: string | null;
  road: string | null;
  routes: string[];
  availabilityStatus: string | null;
  client: string | null;
  nearbyPois: string[];
  latitude: number | null;
  longitude: number | null;
  sourceImportBatch: string | null;
  isActive?: boolean;
  sourceMediaType?: string | null;
  sourceBusRouteRaw?: string | null;
  mediaUnits?: Array<{ unitType: string; format: string; lifecycleStatus: string }>;
}

export interface InventoryAnswerSelection {
  assetId: string;
  status: string;
}

const normalized = (value: string) => value
  .toLowerCase()
  .replace(/\bal karama\b/g, "karama")
  .replace(/\bszr\b/g, "sheikh zayed road")
  .replace(/[^a-z0-9]+/g, " ")
  .trim();

const distanceMeters = (aLat: number, aLon: number, bLat: number, bLon: number) => {
  const rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad;
  const dLon = (bLon - aLon) * rad;
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(h)));
};

export function isInventoryQuestion(question: string): boolean {
  const q = normalized(question);
  if (/\b(campaigns?|promotions?|advertis\w*|ooh|dooh)\b/.test(q) &&
      !/\b(assets?|inventory|available|selected|route|within)\b/.test(q)) return false;
  return /\b(assets?|inventory|shelters?|buses|bus|mupi|kiosk)\b/.test(q) ||
    /\bwithin\s+\d+\s*(?:m|meters?|km|kilometers?)\b/.test(q);
}

/** Only handles inventory-specific questions. Never infer an asset from research claims. */
export function answerInventoryQuestion(
  question: string,
  assets: InventoryAnswerAsset[],
  selections: InventoryAnswerSelection[],
): string | null {
  const q = normalized(question);
  if (!isInventoryQuestion(question)) return null;

  if (!assets.length) {
    return "No real inventory is saved yet. Connect the live shelter sheet or review and import an inventory file before asking about assets.";
  }

  const selectionStatus = /\b(selected|shortlisted|rejected)\b/.exec(q)?.[1];
  const selectedIds = new Set(selections
    .filter((selection) => selection.status === (selectionStatus === "shortlisted" ? "shortlist" : selectionStatus === "rejected" ? "rejected" : "selected"))
    .map((selection) => selection.assetId));
  const wantsSelection = !!selectionStatus;
  const wantsAvailable = /\bavailable\b/.test(q);
  const wantsShelter = /\b(shelters?|bus shelters?|digital shelters?)\b/.test(q);
  const wantsInvalidCoordinates = /\b(invalid|missing)\s+coordinates?\b/.test(q);
  const wantsDigitalTopPanel = /\bdigital\s+top\s+panels?\b/.test(q);
  const wantsDigitalMupi = /\bdigital\s+mupis?\b/.test(q);
  const wantsCombined = /\bdigital\s+bs\s+(?:and|mupi)\b/.test(q) && /\bmupi\b/.test(q);
  const wantsDigitalShelter = /\bdigital\s+bus\s+shelters?\b/.test(q);
  const route = /\broute\s+([a-z0-9-]+)\b/.exec(q)?.[1];
  const distance = /\bwithin\s+(\d+(?:\.\d+)?)\s*(m|meters?|km|kilometers?)\b/.exec(q);
  const radius = distance ? Number(distance[1]) * (distance[2].startsWith("k") ? 1000 : 1) : null;
  const coordinatePair = question.match(/(-?\d{1,2}(?:\.\d+)?)\s*[,;/]\s*(-?\d{1,3}(?:\.\d+)?)/);
  const latitude = coordinatePair ? Number(coordinatePair[1]) : null;
  const longitude = coordinatePair ? Number(coordinatePair[2]) : null;

  if (radius !== null && (radius <= 0 || radius > 200000)) {
    return "Please provide a distance greater than zero and no more than 200 km.";
  }
  if (radius !== null && (latitude === null || longitude === null ||
      Math.abs(latitude) > 90 || Math.abs(longitude) > 180)) {
    return "To list inventory within that distance, provide a latitude and longitude, for example “within 500m of 25.234, 55.302”. I will not guess the location.";
  }

  const areaOrRoad = /\b(?:in|on|at)\s+(.+?)(?:\s+on\s+route|\s+that\s+are|\s+which\s+are|\?|$)/.exec(q)?.[1]
    ?.replace(/\b(?:with|and)\s+(?:available|selected|shortlisted)\b.*$/, "").trim();
  const place = areaOrRoad && !/^route\b/.test(areaOrRoad) && !/^\d/.test(areaOrRoad) ? areaOrRoad : null;

  const matches = assets.filter((asset) => {
    if (asset.isActive === false) return false;
    if (wantsSelection && !selectedIds.has(asset.assetId)) return false;
    if (wantsAvailable && normalized(asset.availabilityStatus ?? "") !== "available") return false;
    if (wantsShelter && !normalized(asset.assetType).includes("shelter")) return false;
    if (wantsInvalidCoordinates && asset.latitude !== null && asset.longitude !== null) return false;
    if (wantsCombined && normalized(asset.sourceMediaType ?? "") !== "digital bs mupi") return false;
    if (wantsDigitalShelter && normalized(asset.sourceMediaType ?? "") !== "digital bus shelter") return false;
    if (wantsDigitalTopPanel && !asset.mediaUnits?.some((unit) =>
      unit.unitType === "TOP_PANEL" && unit.format === "DIGITAL" && unit.lifecycleStatus === "ACTIVE")) return false;
    if (wantsDigitalMupi && !asset.mediaUnits?.some((unit) =>
      unit.unitType === "MUPI" && unit.format === "DIGITAL" && unit.lifecycleStatus === "ACTIVE")) return false;
    if (route && !asset.routes.some((value) => normalized(value) === route || normalized(value) === `route ${route}`)) return false;
    if (place && ![asset.area, asset.road, asset.client, ...asset.nearbyPois].some((value) =>
      normalized(value ?? "").includes(place))) return false;
    if (radius !== null && latitude !== null && longitude !== null &&
        (asset.latitude === null || asset.longitude === null ||
         distanceMeters(latitude, longitude, asset.latitude, asset.longitude) > radius)) return false;
    return true;
  });
  const descriptor = [
    wantsAvailable ? "available" : "",
    wantsSelection ? selectionStatus : "",
    wantsShelter ? "shelter" : "inventory",
    wantsCombined ? "Digital BS & Mupi" : wantsDigitalShelter ? "Digital Bus Shelter" : "",
    wantsDigitalTopPanel ? "with digital top panel" : "",
    wantsDigitalMupi ? "with digital MUPI" : "",
    wantsInvalidCoordinates ? "with invalid/missing coordinates" : "",
    route ? `on Route ${route.toUpperCase()}` : "",
    place ? `matching ${place}` : "",
    radius !== null ? `within ${radius}m of ${latitude}, ${longitude}` : "",
  ].filter(Boolean).join(" ");

  if (!matches.length) {
    return `No imported ${descriptor} assets matched this query. This is a result from the saved inventory, not proof that no such assets exist outside it.`;
  }
  const lines = matches.slice(0, 20).map((asset) => {
    const location = [asset.area, asset.road].filter(Boolean).join(" · ") || "Location unavailable";
    const distanceText = radius !== null && latitude !== null && longitude !== null &&
      asset.latitude !== null && asset.longitude !== null
      ? ` · ${Math.round(distanceMeters(latitude, longitude, asset.latitude, asset.longitude))}m straight-line` : "";
    const media = asset.mediaUnits?.filter((unit) => unit.lifecycleStatus === "ACTIVE")
      .map((unit) => `${unit.format.toLowerCase()} ${unit.unitType === "TOP_PANEL" ? "top panel" : "MUPI"}`).join(", ");
    return `• ${asset.assetId} — ${asset.assetName || asset.assetType}; ${location}; ${media || "media units not recorded"}; ${asset.availabilityStatus || "availability unknown"}${distanceText}`;
  });
  return `Saved inventory matching ${descriptor} (${matches.length}):\n${lines.join("\n")}${matches.length > 20 ? `\n…and ${matches.length - 20} more. Narrow the query to see them.` : ""}\nAvailability is unknown unless explicitly provided by the source; this is not a live booking confirmation. No strategic ranking is applied.`;
}