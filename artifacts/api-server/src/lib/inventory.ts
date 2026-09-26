import type { inventoryAssetsTable } from "@workspace/db";

type InventoryAssetRecord = typeof inventoryAssetsTable.$inferSelect;

export const INVENTORY_DISTANCE_THRESHOLDS = [250, 500, 1000, 2000] as const;

const NORMALIZED_ASSET_TYPES: Record<string, string> = {
  "bus shelter": "Bus Shelter",
  shelter: "Bus Shelter",
  "bus stop shelter": "Bus Shelter",
  bus: "Bus",
  "digital shelter screen": "Digital Shelter Screen",
  mupi: "MUPI",
  kiosk: "Kiosk",
  other: "Other",
};

const AREA_ALIASES: Record<string, string> = {
  karama: "Al Karama",
  "al karama": "Al Karama",
};

const ROAD_ALIASES: Record<string, string> = {
  szr: "Sheikh Zayed Road",
  "sheikh zayed rd": "Sheikh Zayed Road",
  "sheikh zayed road": "Sheikh Zayed Road",
};

const AVAILABILITY_ALIASES: Record<string, string> = {
  available: "Available",
  occupied: "Occupied",
  reserved: "Reserved",
  maintenance: "Maintenance",
  inactive: "Inactive",
};

export const INVENTORY_IMPORT_FIELDS = new Set([
  "assetCode", "assetType", "assetSubtype", "assetName", "area", "road",
  "direction", "emirate", "routes", "depot", "availability", "bookingStatus",
  "campaign", "client", "startDate", "endDate", "mediaFormat", "dimensions",
  "displayTechnology", "latitude", "longitude", "rate", "photoPath", "mapUrl",
  "nearbyPois", "audienceTags", "trafficVisibility", "internalNotes", "tags",
]);

export type ImportAction = "add" | "update" | "skip";
export interface ParsedImportRow {
  assetCode: string | null;
  values: Record<string, unknown>;
  issues: string[];
}

type InputRow = Record<string, unknown>;

function cellString(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value).trim();
  return null;
}

function mappedCell(row: InputRow, mapping: Record<string, string>, field: string): string | null {
  const header = mapping[field];
  if (!header) return null;
  return cellString(row[header]);
}

function splitList(value: string): string[] {
  return [...new Set(value.split(/[,;|]/).map((item) => item.trim()).filter(Boolean))];
}

function normalizeArea(value: string): string {
  const trimmed = value.trim();
  return AREA_ALIASES[trimmed.toLowerCase()] ?? trimmed;
}

function normalizeRoad(value: string): string {
  const trimmed = value.trim();
  return ROAD_ALIASES[trimmed.toLowerCase().replace(/\./g, "")] ?? trimmed;
}

function normalizeAssetType(value: string): string {
  const trimmed = value.trim();
  return NORMALIZED_ASSET_TYPES[trimmed.toLowerCase()] ?? trimmed;
}

function normalizedAvailability(value: string): string {
  const trimmed = value.trim();
  return AVAILABILITY_ALIASES[trimmed.toLowerCase()] ?? trimmed;
}

function parseDate(value: string, field: string, issues: string[]): string | null {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    issues.push(`${field} must use YYYY-MM-DD`);
    return null;
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    issues.push(`${field} is not a real calendar date`);
    return null;
  }
  return value;
}

function parseNumber(value: string, field: string, issues: string[]): number | null {
  if (!value) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    issues.push(`${field} must be a number`);
    return null;
  }
  if (field === "latitude" && (parsed < -90 || parsed > 90)) issues.push("latitude must be between -90 and 90");
  if (field === "longitude" && (parsed < -180 || parsed > 180)) issues.push("longitude must be between -180 and 180");
  if (field === "rate" && parsed < 0) issues.push("rate cannot be negative");
  return parsed;
}

export function parseInventoryImportRow(
  row: InputRow,
  mapping: Record<string, string>,
): ParsedImportRow {
  const issues: string[] = [];
  const values: Record<string, unknown> = {};
  const assetCode = mappedCell(row, mapping, "assetCode")?.trim() || null;
  const assetTypeValue = mappedCell(row, mapping, "assetType");
  if (!assetCode) issues.push("Asset ID is required");
  if (assetCode && assetCode.length > 160) issues.push("Asset ID exceeds 160 characters");
  if (!assetTypeValue) issues.push("Asset type is required");

  for (const field of INVENTORY_IMPORT_FIELDS) {
    const header = mapping[field];
    if (!header) continue;
    const raw = row[header];
    const textValue = cellString(raw);
    if (field === "assetCode" || field === "assetType") continue;
    if (raw != null && typeof raw === "object" && field !== "trafficVisibility") {
      issues.push(`${field} must be a simple cell value`);
      continue;
    }

    if (field === "latitude" || field === "longitude" || field === "rate") {
      const number = parseNumber(textValue ?? "", field, issues);
      if (number !== null || textValue === "") values[field] = number;
    } else if (field === "startDate" || field === "endDate") {
      values[field] = parseDate(textValue ?? "", field, issues);
    } else if (["routes", "nearbyPois", "audienceTags", "tags"].includes(field)) {
      values[field] = textValue ? splitList(textValue) : [];
    } else if (field === "trafficVisibility") {
      if (raw == null || raw === "") {
        values[field] = {};
      } else if (typeof raw === "object" && !Array.isArray(raw)) {
        values[field] = raw;
      } else if (typeof raw === "string") {
        try {
          const parsed: unknown = JSON.parse(raw);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) values[field] = parsed;
          else issues.push("trafficVisibility must be a JSON object");
        } catch {
          issues.push("trafficVisibility must be valid JSON");
        }
      } else {
        issues.push("trafficVisibility must be a JSON object");
      }
    } else if (field === "displayTechnology") {
      if (!textValue) values[field] = null;
      else {
        const normalized = textValue.toLowerCase();
        if (["static", "digital"].includes(normalized)) values[field] = normalized;
        else issues.push("displayTechnology must be static or digital");
      }
    } else if (field === "mapUrl") {
      if (!textValue) values[field] = null;
      else {
        try {
          const parsed = new URL(textValue);
          if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("protocol");
          values[field] = textValue;
        } catch {
          issues.push("mapUrl must be an HTTP or HTTPS URL");
        }
      }
    } else {
      if (textValue && textValue.length > 4000) issues.push(`${field} exceeds 4000 characters`);
      values[field] = textValue || null;
    }
  }

  if (assetTypeValue) {
    values.assetType = normalizeAssetType(assetTypeValue);
    values.assetTypeOriginal = assetTypeValue;
    if (values.assetType === "Bus" &&
        /^(?:bus\s*)?route\s*(?:id|number|no\.?)$/i.test(mapping.assetCode?.trim() ?? "")) {
      issues.push("Route ID is not a physical bus identifier; map a vehicle-level Body Number, Bus Number, Fleet Number, Vehicle ID, Plate Number, or verified Asset ID");
    }
  }
  if (assetCode) values.assetCode = assetCode;
  if (Object.hasOwn(values, "area")) {
    values.areaOriginal = values.area as string | null;
    values.areaNormalized = values.area ? normalizeArea(values.area as string) : null;
  }
  if (Object.hasOwn(values, "road")) {
    values.roadOriginal = values.road as string | null;
    values.roadNormalized = values.road ? normalizeRoad(values.road as string) : null;
  }
  if (Object.hasOwn(values, "availability")) {
    values.availabilityOriginal = values.availability as string | null;
    values.availability = values.availability ? normalizedAvailability(values.availability as string) : null;
  }

  const startDate = values.startDate as string | null | undefined;
  const endDate = values.endDate as string | null | undefined;
  if (startDate && endDate && endDate < startDate) issues.push("endDate must not be before startDate");
  return { assetCode, values, issues };
}

export function mappedRawImportData(
  row: InputRow,
  mapping: Record<string, string>,
): Record<string, unknown> {
  const sourceColumns: Record<string, unknown> = {};
  for (const [field, header] of Object.entries(mapping)) {
    if (INVENTORY_IMPORT_FIELDS.has(field) && Object.hasOwn(row, header)) {
      sourceColumns[header] = row[header];
    }
  }
  return sourceColumns;
}

export function distanceMeters(
  latitudeA: number,
  longitudeA: number,
  latitudeB: number,
  longitudeB: number,
): number {
  const radians = (degrees: number): number => (degrees * Math.PI) / 180;
  const dLatitude = radians(latitudeB - latitudeA);
  const dLongitude = radians(longitudeB - longitudeA);
  const a = Math.sin(dLatitude / 2) ** 2 +
    Math.cos(radians(latitudeA)) * Math.cos(radians(latitudeB)) *
    Math.sin(dLongitude / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function coordinateSearchBounds(
  latitude: number,
  longitude: number,
  thresholdMeters: number,
): { south: number; north: number; west?: number; east?: number } {
  const angularRadius = (thresholdMeters / 6_371_000) * (1 + 1e-12);
  const latitudeRadians = (latitude * Math.PI) / 180;
  const latitudeDelta = (angularRadius * 180) / Math.PI;
  const bounds = {
    south: Math.max(-90, latitude - latitudeDelta),
    north: Math.min(90, latitude + latitudeDelta),
  };
  if (Math.abs(latitudeRadians) + angularRadius >= Math.PI / 2) return bounds;

  const longitudeDelta = (Math.asin(
    Math.sin(angularRadius) / Math.cos(latitudeRadians),
  ) * 180) / Math.PI;
  return {
    ...bounds,
    west: longitude - longitudeDelta,
    east: longitude + longitudeDelta,
  };
}

export function qualityStates(asset: {
  latitude: number | null;
  longitude: number | null;
  photoPath: string | null;
  availability: string | null;
  startDate: string | null;
  endDate: string | null;
}): Array<"complete" | "missing_coordinates" | "missing_photo" | "missing_availability" | "needs_review"> {
  const states: Array<"complete" | "missing_coordinates" | "missing_photo" | "missing_availability" | "needs_review"> = [];
  if (asset.latitude == null || asset.longitude == null) states.push("missing_coordinates");
  if (!asset.photoPath?.trim()) states.push("missing_photo");
  if (!asset.availability?.trim()) states.push("missing_availability");
  if ((asset.latitude == null) !== (asset.longitude == null) ||
      (!!asset.startDate && !!asset.endDate && asset.endDate < asset.startDate)) {
    states.push("needs_review");
  }
  if (states.length === 0) states.push("complete");
  return states;
}

export function serializeInventoryAsset(asset: InventoryAssetRecord) {
  const states = qualityStates(asset);
  return {
    ...asset,
    qualityStates: states,
    locationUnavailable: asset.latitude == null || asset.longitude == null,
  };
}
