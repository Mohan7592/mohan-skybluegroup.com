import type { InventoryAsset, InventoryAssetPage, ProjectLocation } from "@workspace/api-client-react";

export const bands = [200, 500, 800, 1000] as const;
export type ShelterBand = typeof bands[number];
export type ShelterKind = "shelters" | "digitalShelters" | "staticMupis" | "digitalMupis";
export type PlanningLayer = "selected" | "shortlisted" | "recommended" | "rejected";
export type ShelterLayer = ShelterKind | PlanningLayer;
export type CampaignGeography = "DUBAI" | "ABU_DHABI" | "UAE" | "CUSTOM";

function normalizeGeographyText(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/[.,]/g, " ").replace(/\s+/g, " ");
}

function containsCampaignArea(text: string, campaignAreas: string[]): boolean {
  const normalizedText = normalizeGeographyText(text);
  return campaignAreas.some(area => {
    const candidate = normalizeGeographyText(area);
    return candidate.length > 0 && new RegExp(
      `(?:^|[^a-z0-9])${candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+")}(?:$|[^a-z0-9])`,
      "i",
    ).test(normalizedText);
  });
}

/** The SkyBlue inventory is a Dubai network; only CUSTOM narrows it by source-backed area/road text. */
export function shelterInCampaignGeography(
  asset: InventoryAsset,
  geography: CampaignGeography | null | undefined,
  campaignAreas: string[] = [],
): boolean {
  if (geography === "DUBAI" || geography === "UAE") return true;
  if (geography !== "CUSTOM") return false;
  const evidence = [
    asset.area, asset.areaNormalized, asset.road, asset.roadNormalized,
    asset.emirate, asset.assetName, asset.stopName,
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0).join(" ");
  return containsCampaignArea(evidence, campaignAreas);
}

export function sheltersInCampaignGeography(
  assets: InventoryAsset[],
  geography: CampaignGeography | null | undefined,
  campaignAreas: string[] = [],
): InventoryAsset[] {
  return assets.filter(asset => shelterInCampaignGeography(asset, geography, campaignAreas));
}

export function validCoordinates(lat: number | null | undefined, lng: number | null | undefined): boolean {
  return typeof lat === "number" && typeof lng === "number" && Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);
}
export function activeKinds(asset: InventoryAsset): ShelterKind[] {
  const units = asset.mediaUnits?.filter(u => u.lifecycleStatus === "ACTIVE") || [];
  return ([
    ["shelters", "STATIC", "TOP_PANEL"],
    ["digitalShelters", "DIGITAL", "TOP_PANEL"],
    ["staticMupis", "STATIC", "MUPI"],
    ["digitalMupis", "DIGITAL", "MUPI"],
  ] as const).filter(([, format, type]) => units.some(u => u.format === format && u.unitType === type)).map(([kind]) => kind);
}
export function isActiveShelter(asset: InventoryAsset): boolean {
  return asset.sourceFamily === "BUS_SHELTER" && asset.isActive !== false && asset.sourceLifecycleStatus === "ACTIVE" && !asset.locationUnavailable && !asset.removedDetectedAt && !asset.syncReviewReasons?.length && validCoordinates(asset.latitude, asset.longitude) && activeKinds(asset).length > 0;
}
/** Format and planning layers are orthogonal. Hidden formats never hide an enabled planning decision. */
export function shelterMapLayers(asset: InventoryAsset, visible: ReadonlySet<string>, planning: readonly PlanningLayer[]) {
  if (!isActiveShelter(asset)) return null;
  const formats = activeKinds(asset).filter(kind => visible.has(kind));
  const overlays = planning.filter((layer, index) => planning.indexOf(layer) === index && visible.has(layer));
  return formats.length || overlays.length ? { formats, overlays } : null;
}
export function activeShelters(assets: InventoryAsset[]): InventoryAsset[] {
  const unique = new Map<string, InventoryAsset>();
  for (const asset of assets) {
    if (!isActiveShelter(asset)) continue;
    unique.set(asset.id, asset);
  }
  return [...unique.values()];
}
export async function loadShelterPages(fetchPage: (offset: number, signal?: AbortSignal) => Promise<InventoryAssetPage> = async (offset, signal) => {
  const { listInventoryAssets } = await import("@workspace/api-client-react");
  return listInventoryAssets({ limit: 200, offset, sourceFamily: "BUS_SHELTER", lifecycleStatus: "ACTIVE", coordinateState: "VALID" }, { signal });
}, signal?: AbortSignal): Promise<InventoryAsset[]> {
  const all: InventoryAsset[] = [];
  let offset = 0;
  let total: number | null = null;
  do {
    const page = await fetchPage(offset, signal);
    if (!page || !Array.isArray(page.items) || !Number.isInteger(page.total) || page.total < 0 || page.offset !== offset || !Number.isInteger(page.limit) || page.limit < 1 || (total !== null && page.total !== total)) throw new Error(`Shelter network page at offset ${offset} is incomplete or inconsistent. Retry the full network load.`);
    total = page.total;
    if (page.items.length === 0 && offset < total) throw new Error(`Shelter network page at offset ${offset} was empty before all ${total} records loaded.`);
    all.push(...page.items);
    offset += page.items.length;
  } while (offset < total);
  return activeShelters(all);
}
export function distanceMeters(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad, dLng = (bLng - aLng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLng / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}
export function clientProximity(location: ProjectLocation, shelters: InventoryAsset[]) {
  const campaignGeographyStatus = (location as ProjectLocation & { campaignGeographyStatus?: string | null }).campaignGeographyStatus;
  if (location.role !== "CLIENT" || location.reviewStatus === "REJECTED" || campaignGeographyStatus !== "IN_CAMPAIGN_GEOGRAPHY" || !validCoordinates(location.latitude, location.longitude)) return null;
  const ordered = shelters.map(shelter => ({ shelter, distance: distanceMeters(location.latitude!, location.longitude!, shelter.latitude!, shelter.longitude!) })).sort((a, b) => a.distance - b.distance);
  return { nearest: ordered[0] || null, distances: new Map(ordered.map(item => [item.shelter.id, item.distance])), counts: Object.fromEntries(bands.map(band => [band, ordered.filter(item => item.distance <= band).length])) as Record<ShelterBand, number>, preview: location.reviewStatus !== "APPROVED" };
}