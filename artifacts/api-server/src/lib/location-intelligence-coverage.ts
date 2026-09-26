import type {
  inventoryAssetsTable,
  inventoryMediaUnitsTable,
  projectLocationsTable,
} from "@workspace/db";

export const LOCATION_RADII = [200, 500, 800, 1000] as const;

const STORE_MEDIA_TYPES = {
  digitalTopPanels: { unitType: "TOP_PANEL", format: "DIGITAL" },
  digitalMupis: { unitType: "MUPI", format: "DIGITAL" },
} as const;

type StoreCoverageLocation = typeof projectLocationsTable.$inferSelect;
type StoreCoverageAsset = typeof inventoryAssetsTable.$inferSelect;
type StoreCoverageUnit = typeof inventoryMediaUnitsTable.$inferSelect;

function validCoordinates(latitude: number | null, longitude: number | null): latitude is number {
  return latitude !== null && longitude !== null &&
    Number.isFinite(latitude) && Number.isFinite(longitude) &&
    latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180;
}

function distanceMeters(latitudeA: number, longitudeA: number, latitudeB: number, longitudeB: number): number {
  const radians = (degrees: number): number => (degrees * Math.PI) / 180;
  const dLatitude = radians(latitudeB - latitudeA);
  const dLongitude = radians(longitudeB - longitudeA);
  const a = Math.sin(dLatitude / 2) ** 2 +
    Math.cos(radians(latitudeA)) * Math.cos(radians(latitudeB)) *
    Math.sin(dLongitude / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function isWithinStraightLineRadius(distance: number, radiusMeters: number): boolean {
  return distance <= radiusMeters;
}

function emptyMediaUnitCounts() {
  return { digitalTopPanels: 0, digitalMupis: 0, static: 0 };
}

/**
 * Builds store coverage only from approved, coordinate-backed client locations
 * and currently eligible active shelter inventory. Counts are based on unique
 * shelter/media-unit IDs; this is proximity coverage, not audience reach.
 */
export function buildStoreCoverage(
  locations: StoreCoverageLocation[],
  assets: StoreCoverageAsset[],
  units: StoreCoverageUnit[],
) {
  const activeUnitsByAsset = new Map<string, StoreCoverageUnit[]>();
  for (const unit of units) {
    if (unit.lifecycleStatus !== "ACTIVE") continue;
    const parentUnits = activeUnitsByAsset.get(unit.parentInventoryAssetId) ?? [];
    parentUnits.push(unit);
    activeUnitsByAsset.set(unit.parentInventoryAssetId, parentUnits);
  }

  const eligibleAssets = assets.filter((asset) =>
    asset.isActive &&
    asset.sourceFamily === "BUS_SHELTER" &&
    asset.sourceLifecycleStatus === "ACTIVE" &&
    asset.assetType === "Bus Shelter" &&
    asset.syncReviewReasons.length === 0 &&
    validCoordinates(asset.latitude, asset.longitude) &&
    (activeUnitsByAsset.get(asset.id)?.length ?? 0) > 0);

  const locationResults = locations
    .filter((location) =>
      location.role === "CLIENT" &&
      location.reviewStatus === "APPROVED" &&
      validCoordinates(location.latitude, location.longitude))
    .map((location) => {
      const nearbyShelters = eligibleAssets
        .map((asset) => {
          const distance = distanceMeters(
            location.latitude!,
            location.longitude!,
            asset.latitude!,
            asset.longitude!,
          );
          const assetUnits = activeUnitsByAsset.get(asset.id) ?? [];
          return {
            shelterId: asset.id,
            assetCode: asset.assetCode,
            assetName: asset.assetName,
            latitude: asset.latitude,
            longitude: asset.longitude,
            distanceMeters: distance,
            mediaUnitCounts: {
              digitalTopPanels: assetUnits.filter((unit) =>
                unit.unitType === STORE_MEDIA_TYPES.digitalTopPanels.unitType &&
                unit.format === STORE_MEDIA_TYPES.digitalTopPanels.format).length,
              digitalMupis: assetUnits.filter((unit) =>
                unit.unitType === STORE_MEDIA_TYPES.digitalMupis.unitType &&
                unit.format === STORE_MEDIA_TYPES.digitalMupis.format).length,
              static: assetUnits.filter((unit) => unit.format === "STATIC").length,
            },
          };
        })
        .filter(({ distanceMeters: distance }) =>
          isWithinStraightLineRadius(distance, LOCATION_RADII.at(-1)!))
        .sort((a, b) => a.distanceMeters - b.distanceMeters || a.shelterId.localeCompare(b.shelterId));

      const bands = Object.fromEntries(LOCATION_RADII.map((radiusMeters) => {
        const matchedShelters = nearbyShelters.filter((shelter) =>
          isWithinStraightLineRadius(shelter.distanceMeters, radiusMeters));
        return [radiusMeters, {
          shelterCount: matchedShelters.length,
          matchedShelterIds: matchedShelters.map(({ shelterId }) => shelterId),
          mediaUnitCounts: matchedShelters.reduce((counts, shelter) => ({
            digitalTopPanels: counts.digitalTopPanels + shelter.mediaUnitCounts.digitalTopPanels,
            digitalMupis: counts.digitalMupis + shelter.mediaUnitCounts.digitalMupis,
            static: counts.static + shelter.mediaUnitCounts.static,
          }), emptyMediaUnitCounts()),
        }];
      }));
      return {
        id: location.id,
        name: location.name,
        category: location.category,
        address: location.address,
        latitude: location.latitude,
        longitude: location.longitude,
        bands,
        nearbyShelters,
      };
    });

  const eligibleAssetById = new Map(eligibleAssets.map((asset) => [asset.id, asset]));
  const aggregateBands = Object.fromEntries(LOCATION_RADII.map((radiusMeters) => {
    const matchedById = new Map<string, StoreCoverageAsset>();
    let locationsCoveredCount = 0;
    for (const location of locationResults) {
      const matchedIds = location.bands[radiusMeters as keyof typeof location.bands].matchedShelterIds;
      if (matchedIds.length > 0) locationsCoveredCount++;
      for (const shelterId of matchedIds) {
        const asset = eligibleAssetById.get(shelterId);
        if (asset) matchedById.set(shelterId, asset);
      }
    }
    const matchedUnitIds = new Set<string>();
    const mediaUnitCounts = emptyMediaUnitCounts();
    for (const asset of matchedById.values()) {
      for (const unit of activeUnitsByAsset.get(asset.id) ?? []) {
        if (matchedUnitIds.has(unit.id)) continue;
        matchedUnitIds.add(unit.id);
        if (unit.unitType === "TOP_PANEL" && unit.format === "DIGITAL") mediaUnitCounts.digitalTopPanels++;
        else if (unit.unitType === "MUPI" && unit.format === "DIGITAL") mediaUnitCounts.digitalMupis++;
        else if (unit.format === "STATIC") mediaUnitCounts.static++;
      }
    }
    return [radiusMeters, {
      locationsCoveredCount,
      uniqueShelterCount: matchedById.size,
      mediaUnitCounts,
    }];
  }));

  return {
    radiiMeters: [...LOCATION_RADII],
    locations: locationResults,
    aggregate: { bands: aggregateBands },
    limitations: [
      "Coverage counts active eligible shelters near approved client locations using straight-line distance only.",
      "Coverage is not audience reach, footfall, traffic, impressions, availability, booking, or reservation.",
    ],
  };
}