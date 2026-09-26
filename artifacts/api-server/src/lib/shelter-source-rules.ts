import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { inventoryAssetsTable } from "@workspace/db";

export type ShelterSheetName = "Single" | "Double";

export type ShelterMediaUnitPlan = {
  unitType: "TOP_PANEL" | "MUPI";
  format: "STATIC" | "DIGITAL";
  lifecycleStatus: "ACTIVE" | "REMOVED";
  sourceType: string;
  currentClient: string | null;
  campaignStart: string | null;
  campaignEnd: string | null;
  internalNotes: string | null;
};

export function compareShelterMediaUnit(
  unitType: string,
  current: Record<string, unknown> | null,
  desired: Record<string, unknown>,
): Record<string, { before: unknown; after: unknown }> {
  const changes: Record<string, { before: unknown; after: unknown }> = {};
  for (const [field, afterValue] of Object.entries(desired)) {
    const before = current?.[field] ?? null;
    const after = afterValue ?? null;
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      changes[`mediaUnits.${unitType}.${field}`] = { before, after };
    }
  }
  return changes;
}

export function compareShelterRecord(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Record<string, { before: unknown; after: unknown }> {
  const changes: Record<string, { before: unknown; after: unknown }> = {};
  for (const [field, value] of Object.entries(after)) {
    if (["lastSeenAt", "updatedAt", "createdAt", "sourceRecordHash"].includes(field)) continue;
    if (!isDeepStrictEqual(before[field] ?? null, value ?? null)) {
      changes[field] = { before: before[field] ?? null, after: value ?? null };
    }
  }
  return changes;
}

export function normalizeShelterNumber(value: string): string {
  const normalized = value.trim().replace(/[\s-]+/g, "-").replace(/^-|-$/g, "");
  if (!normalized) throw new Error("Shelter No is blank");
  return normalized.toLocaleUpperCase();
}

export function shelterSourceKey(sourceSheet: "Single" | "Double", shelterNumber: string): string {
  return `BUS_SHELTER:${sourceSheet.toLocaleUpperCase()}:${normalizeShelterNumber(shelterNumber)}`;
}

export function normalizeShelterMediaType(raw: string | null): string | null {
  if (!raw) return null;
  const cleaned = raw.trim();
  if (/^standared$/i.test(cleaned) || /^standard$/i.test(cleaned)) return "Standard";
  if (/^digital bus shelter$/i.test(cleaned)) return "Digital Bus Shelter";
  if (/^digital mupi$/i.test(cleaned)) return "Digital Mupi";
  if (/^digital bs\s*&\s*mupi$/i.test(cleaned)) return "Digital BS & Mupi";
  return cleaned;
}

export function parseShelterCoordinates(raw: string | null): {
  latitude: number | null;
  longitude: number | null;
  valid: boolean;
} {
  if (!raw) return { latitude: null, longitude: null, valid: false };
  const match = raw.trim().match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*,\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))$/);
  if (!match) return { latitude: null, longitude: null, valid: false };
  const latitude = Number(match[1]);
  const longitude = Number(match[2]);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) ||
      latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    return { latitude: null, longitude: null, valid: false };
  }
  return { latitude, longitude, valid: true };
}

export function isShelterRemoved(accountability: string | null, remarks: string | null): boolean {
  if (remarks?.trim().toLocaleLowerCase() === "shelter removed") return true;
  return !!accountability && /(?:^|[\s/])(?:RTA|SB)\s*\/\s*Removed(?:$|[\s/])/i.test(accountability);
}

function mupiState(raw: string | null): "PRESENT" | "REMOVED" | "ABSENT" {
  if (!raw) return "ABSENT";
  if (/mupi\s+removed/i.test(raw)) return "REMOVED";
  if (/^(?:1|yes|y|true|present|available)$/i.test(raw.trim())) return "PRESENT";
  return "ABSENT";
}

export function parseShelterCampaignDate(value: string | null): string | null {
  if (!value) return null;
  const raw = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const date = new Date(`${raw}T00:00:00.000Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === raw ? raw : null;
  }
  const named = raw.match(/^(\d{1,2})[/-]([a-z]+)[/-](\d{4})$/i);
  const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  let day: number;
  let month: number;
  let year: number;
  if (named) {
    day = Number(named[1]);
    month = months.indexOf(named[2].slice(0, 3).toLowerCase()) + 1;
    year = Number(named[3]);
  } else {
    const numeric = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (!numeric) return null;
    const first = Number(numeric[1]);
    const second = Number(numeric[2]);
    if (first <= 12 && second > 12) {
      month = first;
      day = second;
    } else if (first > 12 && second <= 12) {
      day = first;
      month = second;
    } else {
      return null; // Ambiguous numeric day/month or invalid values need review.
    }
    year = Number(numeric[3]);
  }
  if (!month || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 ||
      date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
}

export function shelterMediaPlan(
  type: string | null,
  mupiRaw: string | null,
  currentClient: string | null = null,
  campaignStart: string | null = null,
  campaignEnd: string | null = null,
  mupiRemovedByRemark = false,
  shelterRemoved = false,
): ShelterMediaUnitPlan[] {
  const mupi = mupiRemovedByRemark ? "REMOVED" : mupiState(mupiRaw);
  const units: ShelterMediaUnitPlan[] = [];
  const unit = (
    unitType: ShelterMediaUnitPlan["unitType"],
    format: ShelterMediaUnitPlan["format"],
    lifecycleStatus: ShelterMediaUnitPlan["lifecycleStatus"],
    sourceType: string,
    internalNotes: string | null,
  ): ShelterMediaUnitPlan => ({
    unitType,
    format,
    lifecycleStatus,
    sourceType,
    currentClient,
    campaignStart: parseShelterCampaignDate(campaignStart),
    campaignEnd: parseShelterCampaignDate(campaignEnd),
    internalNotes,
  });
  if (type === "Standard") {
    units.push(unit("TOP_PANEL", "STATIC", "ACTIVE", type, null));
    if (mupi !== "ABSENT") units.push(unit(
      "MUPI", "STATIC", mupi === "REMOVED" ? "REMOVED" : "ACTIVE", type,
      mupi === "REMOVED" ? "Mupi Removed in source" : null,
    ));
  } else if (type === "Digital Bus Shelter") {
    units.push(unit("TOP_PANEL", "DIGITAL", "ACTIVE", type, null));
    if (mupi !== "ABSENT") units.push(unit(
      "MUPI", "STATIC", mupi === "REMOVED" ? "REMOVED" : "ACTIVE", type,
      mupi === "REMOVED" ? "Mupi Removed in source" : null,
    ));
  } else if (type === "Digital Mupi") {
    units.push(unit("TOP_PANEL", "STATIC", "ACTIVE", type, null));
    if (mupi !== "ABSENT") units.push(unit(
      "MUPI", "DIGITAL", mupi === "REMOVED" ? "REMOVED" : "ACTIVE", type,
      mupi === "REMOVED" ? "Mupi Removed in source" : null,
    ));
  } else if (type === "Digital BS & Mupi") {
    units.push(unit("TOP_PANEL", "DIGITAL", "ACTIVE", type, null));
    if (mupi !== "ABSENT") units.push(unit(
      "MUPI", "DIGITAL", mupi === "REMOVED" ? "REMOVED" : "ACTIVE", type,
      mupi === "REMOVED" ? "Mupi Removed in source" : null,
    ));
  }
  if (shelterRemoved) {
    for (const unit of units) {
      unit.lifecycleStatus = "REMOVED";
      unit.internalNotes = "Shelter Removed in source";
    }
  }
  return units;
}

export type ParsedShelter = {
  sourceKey: string;
  sourceSheet: ShelterSheetName;
  shelterNumber: string;
  values: typeof inventoryAssetsTable.$inferInsert;
  mediaUnits: ShelterMediaUnitPlan[];
  hash: string;
};

type ShelterRow = Record<string, unknown>;

function column(row: ShelterRow, aliases: string[]): string | null {
  const matches = new Set(aliases.map((name) => name.toLocaleLowerCase().replace(/[^a-z0-9]/g, "")));
  for (const [header, value] of Object.entries(row)) {
    if (!matches.has(header.toLocaleLowerCase().replace(/[^a-z0-9]/g, "")) || value == null) continue;
    const normalized = String(value).trim();
    return normalized || null;
  }
  return null;
}

function sourceColumns(sourceSheet: ShelterSheetName) {
  return sourceSheet === "Single"
    ? {
        powerStatus: ["Power-STATUS"],
        area: ["Single Shelters Area"],
        stopName: ["Single Shelters Bus Stop Name"],
        tentativeClient: ["Not yet confirmed", "Not Yet Confirmed"],
        currentClient: ["Clients"],
        remarks: ["Remark", "Remarks"],
        campaignStart: ["Stard date", "Stard Date"],
      }
    : {
        powerStatus: ["Power-Status106", "Power-Status 106"],
        area: ["Double Shelters Area"],
        stopName: ["Double Shelters Bus Stop Name"],
        tentativeClient: ["Not Yet Confirmed", "Not yet confirmed"],
        currentClient: ["Clients"],
        remarks: ["Remarks", "Remark"],
        campaignStart: ["Stard Date", "Stard date"],
      };
}

function stableHash(record: Record<string, unknown>): string {
  const sortRecursively = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sortRecursively);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, sortRecursively(nested)]));
    }
    return value;
  };
  return createHash("sha256").update(JSON.stringify(sortRecursively(record))).digest("hex");
}

export function parseShelterSourceRow(sourceSheet: ShelterSheetName, row: ShelterRow): ParsedShelter | null {
  const shelterNumberRaw = column(row, ["Shelter No"]);
  if (!shelterNumberRaw) return null;
  const shelterNumber = normalizeShelterNumber(shelterNumberRaw);
  const sourceKey = shelterSourceKey(sourceSheet, shelterNumberRaw);
  const columns = sourceColumns(sourceSheet);
  const sourceMediaTypeRaw = column(row, ["Type"]);
  const mediaType = normalizeShelterMediaType(sourceMediaTypeRaw);
  const accountability = column(row, ["Accountability"]);
  const remarks = column(row, columns.remarks);
  const mupiRaw = column(row, ["Mupi"]);
  const coordinatesRaw = column(row, ["Coordinates"]);
  const coordinates = parseShelterCoordinates(coordinatesRaw);
  const removed = isShelterRemoved(accountability, remarks);
  const reviewReasons: string[] = [];
  if (!coordinates.valid) reviewReasons.push("MISSING_OR_INVALID_COORDINATES");
  if (!mediaType) reviewReasons.push("MISSING_MEDIA_TYPE");
  const data = {
    sourceFamily: "BUS_SHELTER",
    sourceKey,
    sourceSheet,
    shelterNumber: shelterNumberRaw,
    shelterConfiguration: sourceSheet === "Single" ? "SINGLE" : "DOUBLE",
    sourceMediaType: mediaType,
    assetType: "Bus Shelter",
    assetSubtype: mediaType,
    assetTypeOriginal: sourceMediaTypeRaw,
    assetCode: sourceKey,
    assetName: `Shelter ${shelterNumber}`,
    area: column(row, columns.area),
    areaOriginal: column(row, columns.area),
    areaNormalized: column(row, columns.area),
    powerStatus: column(row, columns.powerStatus),
    lightType: column(row, ["Light Type"]),
    accountability,
    sourceBusRouteRaw: column(row, ["Bus Route"]),
    stopName: column(row, columns.stopName),
    coordinatesRaw,
    latitude: coordinates.latitude,
    longitude: coordinates.longitude,
    mupiRaw,
    sourceMapLink: column(row, ["Google link"]),
    tentativeClient: column(row, columns.tentativeClient),
    currentClientRaw: column(row, columns.currentClient),
    artworkRaw: column(row, ["Artwork"]),
    remarks,
    campaignStartDateRaw: column(row, columns.campaignStart),
    campaignEndDateRaw: column(row, ["End Date"]),
    availability: "UNKNOWN",
    isActive: !removed,
    sourceLifecycleStatus: removed ? "REMOVED" : "ACTIVE",
    removedDetectedAt: null,
    syncReviewReasons: reviewReasons,
    rawImportData: { ...row },
    routes: [],
    nearbyPois: [],
    audienceTags: [],
    trafficVisibility: {},
    tags: [],
    metadata: {},
  };
  const mediaUnits = shelterMediaPlan(
    mediaType,
    mupiRaw,
    column(row, columns.currentClient),
    column(row, columns.campaignStart),
    column(row, ["End Date"]),
    !!remarks && /mupi\s+removed/i.test(remarks),
    removed,
  );
  return {
    sourceKey,
    sourceSheet,
    shelterNumber,
    values: data as typeof inventoryAssetsTable.$inferInsert,
    mediaUnits,
    hash: stableHash({ ...data, removedDetectedAt: removed ? "REMOVED" : null, mediaUnits }),
  };
}