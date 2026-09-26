import { ReplitConnectors } from "@replit/connectors-sdk";
import { createHash } from "node:crypto";
import { busRouteStructuralIdentity } from "./bus-route-identity.js";

export const EXPECTED_BUS_ROUTES_SHEET_TITLE = "Bus Routes_Master File";
export const ROUTE_ID_HEADERS = ["Route ID", "Route Number"] as const;
export const ALLOCATED_BUS_COUNT_HEADER = "Buses per Route";

type SheetsMetadata = {
  properties?: { title?: string };
  sheets?: Array<{ properties?: { title?: string; hidden?: boolean } }>;
};
type ValuesResponse = { valueRanges?: Array<{ range?: string; values?: unknown[][] }> };

export type BusRouteSourceRowInput = {
  sheetName: string;
  sourceRowNumber: number;
  rawData: Record<string, unknown>;
  routeId: string;
  normalizedRouteId: string;
  sourceIdentity: string;
  structuralIdentity: string;
  allocatedBusCount: number | null;
};
export type DiscoveredBusSheet = {
  name: string;
  kind: "route" | "vehicle";
  dataRows: number;
  headers: string[];
};

function configuredSheetId(): string {
  const id = process.env.BUS_ROUTES_MASTER_SHEET_ID?.trim();
  if (!id) throw new Error("BUS_ROUTES_MASTER_SHEET_ID is not configured");
  return id;
}

async function readJson<T>(connectors: ReplitConnectors, path: string): Promise<T> {
  const response = await connectors.proxy("google-sheet", path);
  if (!response.ok) {
    throw new Error(`Google Sheets request failed (${response.status} ${response.statusText})`);
  }
  try {
    return await response.json() as T;
  } catch {
    throw new Error("Google Sheets returned an unreadable response");
  }
}

function cellText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  throw new Error("Google Sheet contains a non-scalar cell value");
}

export function normalizeRouteId(routeId: string): string {
  return routeId.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function normalizedHeader(value: string): string {
  return value.toLocaleLowerCase().replace(/[^a-z0-9]/g, "");
}

function isVehicleHeader(headers: string[]): boolean {
  const normalized = new Set(headers.map(normalizedHeader));
  return ["bodynumber", "busnumber", "vehicleid", "fleetnumber", "platenumber"]
    .some((header) => normalized.has(header));
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function quoteSheetNameForA1(sheetName: string): string {
  return `'${sheetName.replaceAll("'", "''")}'`;
}

export function sheetNameFromA1Range(range: string | undefined): string | null {
  if (!range) return null;
  const rangePrefix = range.split("!")[0];
  if (rangePrefix.startsWith("'") && rangePrefix.endsWith("'")) {
    return rangePrefix.slice(1, -1).replaceAll("''", "'");
  }
  return rangePrefix;
}

function allocatedBusCountFromCell(value: unknown, sheetName: string, rowNumber: number): number | null {
  const text = cellText(value).trim();
  if (!text) return null;
  if (typeof value === "string" && !/^\d+$/.test(text)) {
    throw new Error(`"${sheetName}" row ${rowNumber} has invalid ${ALLOCATED_BUS_COUNT_HEADER}: "${text}"`);
  }
  const count = Number(text);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`"${sheetName}" row ${rowNumber} has invalid ${ALLOCATED_BUS_COUNT_HEADER}: "${text}"`);
  }
  return count;
}

export function parseRouteSheetValues(
  sheetName: string,
  values: unknown[][] | undefined,
): { rows: BusRouteSourceRowInput[]; discovery: DiscoveredBusSheet } {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error(`The "${sheetName}" tab is empty or unreadable`);
  }
  const headers = values[0]?.map((value) => cellText(value));
  if (!headers?.some((header) => header.trim().length > 0)) {
    throw new Error(`The "${sheetName}" tab does not have a readable header row`);
  }
  if (isVehicleHeader(headers)) {
    const dataRows = values.slice(1).filter((cells) => cells?.some((value) => cellText(value).trim())).length;
    return { rows: [], discovery: { name: sheetName, kind: "vehicle", dataRows, headers } };
  }
  const routeIdIndex = headers.findIndex((header) =>
    ROUTE_ID_HEADERS.some((candidate) => normalizedHeader(header) === normalizedHeader(candidate)));
  if (routeIdIndex < 0) {
    throw new Error(`The "${sheetName}" tab is missing required source column: ${ROUTE_ID_HEADERS.join(" or ")}`);
  }
  const allocatedBusCountIndex = headers.findIndex((header) =>
    normalizedHeader(header) === normalizedHeader(ALLOCATED_BUS_COUNT_HEADER));
  const rows: BusRouteSourceRowInput[] = [];
  values.slice(1).forEach((cells, index) => {
    const rowNumber = index + 2;
    const hasData = cells?.some((value) => cellText(value).trim().length > 0) ?? false;
    if (!hasData) return;
    const routeId = cellText(cells?.[routeIdIndex]).trim();
    if (!routeId) {
      throw new Error(`"${sheetName}" row ${rowNumber} contains data but has a blank Route ID/Route Number`);
    }
    const rawData: Record<string, unknown> = {};
    headers.forEach((header, column) => {
      const value = cells?.[column] ?? "";
      cellText(value);
      if (header.trim()) rawData[header] = value;
    });
    const allocatedBusCount = allocatedBusCountIndex < 0
      ? null
      : allocatedBusCountFromCell(cells?.[allocatedBusCountIndex], sheetName, rowNumber);
    const structuralIdentity = busRouteStructuralIdentity(sheetName, rawData, routeId);
    rows.push({
      sheetName,
      sourceRowNumber: rowNumber,
      rawData,
      routeId,
      normalizedRouteId: normalizeRouteId(routeId),
      sourceIdentity: "",
      structuralIdentity,
      allocatedBusCount,
    });
  });
  const rowsByStructure = new Map<string, BusRouteSourceRowInput[]>();
  for (const row of rows) {
    rowsByStructure.set(row.structuralIdentity, [...(rowsByStructure.get(row.structuralIdentity) ?? []), row]);
  }
  for (const [structure, structuralRows] of rowsByStructure) {
    const structureDigest = createHash("sha256").update(structure).digest("hex");
    if (structuralRows.length === 1) {
      structuralRows[0]!.sourceIdentity = structureDigest;
      continue;
    }
    const occurrences = new Map<string, number>();
    for (const row of structuralRows) {
      const content = stableJson(row.rawData);
      const contentDigest = createHash("sha256").update(content).digest("hex");
      const occurrence = occurrences.get(contentDigest) ?? 0;
      occurrences.set(contentDigest, occurrence + 1);
      row.sourceIdentity = `${structureDigest}:ambiguous:${contentDigest}:${occurrence}`;
    }
  }
  if (!rows.length) throw new Error(`The "${sheetName}" route tab has no valid data rows`);
  return { rows, discovery: { name: sheetName, kind: "route", dataRows: rows.length, headers } };
}

export async function readBusRouteSourceSheets(): Promise<{
  title: string;
  discoveredSheets: DiscoveredBusSheet[];
  rows: BusRouteSourceRowInput[];
}> {
  const connectors = new ReplitConnectors();
  const sheetId = configuredSheetId();
  const metadata = await readJson<SheetsMetadata>(
    connectors,
    `/v4/spreadsheets/${encodeURIComponent(sheetId)}?fields=properties.title,sheets.properties(title,hidden)`,
  );
  const title = metadata.properties?.title;
  if (!title) throw new Error("Google Sheets response is missing the spreadsheet title");
  if (title !== EXPECTED_BUS_ROUTES_SHEET_TITLE) {
    throw new Error(`Connected spreadsheet title must be exactly "${EXPECTED_BUS_ROUTES_SHEET_TITLE}"`);
  }
  const visibleSheets = (metadata.sheets ?? [])
    .filter((sheet) => !sheet.properties?.hidden)
    .map((sheet) => sheet.properties?.title)
    .filter((name): name is string => !!name);
  if (!visibleSheets.length) throw new Error("Google Sheets spreadsheet has no visible tabs");

  const ranges = visibleSheets.map((name) =>
    `ranges=${encodeURIComponent(`${quoteSheetNameForA1(name)}!A1:ZZ`)}`).join("&");
  const result = await readJson<ValuesResponse>(
    connectors,
    `/v4/spreadsheets/${encodeURIComponent(sheetId)}/values:batchGet?${ranges}&majorDimension=ROWS`,
  );
  if (!Array.isArray(result.valueRanges) || result.valueRanges.length !== visibleSheets.length) {
    throw new Error("Google Sheets returned incomplete tab data");
  }
  const byRange = new Map(result.valueRanges.map((entry) => [sheetNameFromA1Range(entry.range), entry.values]));
  const parsed = visibleSheets.map((name) => {
    const values = byRange.get(name);
    if (!values) throw new Error(`Google Sheets did not return the "${name}" tab`);
    return parseRouteSheetValues(name, values);
  });
  return {
    title,
    discoveredSheets: parsed.map((sheet) => sheet.discovery),
    rows: parsed.flatMap((sheet) => sheet.rows),
  };
}

export async function getBusRoutesSheetConnectionStatus(): Promise<{
  configured: boolean;
  connected: boolean;
  spreadsheetTitle: string | null;
  requiredTitle: string;
  availableSheets: string[];
  error: string | null;
}> {
  const configured = Boolean(process.env.BUS_ROUTES_MASTER_SHEET_ID?.trim());
  if (!configured) {
    return {
      configured: false,
      connected: false,
      spreadsheetTitle: null,
      requiredTitle: EXPECTED_BUS_ROUTES_SHEET_TITLE,
      availableSheets: [],
      error: "BUS_ROUTES_MASTER_SHEET_ID is not configured",
    };
  }
  try {
    const connectors = new ReplitConnectors();
    const metadata = await readJson<SheetsMetadata>(
      connectors,
      `/v4/spreadsheets/${encodeURIComponent(configuredSheetId())}?fields=properties.title,sheets.properties(title,hidden)`,
    );
    const title = metadata.properties?.title;
    if (!title) throw new Error("Google Sheets response is missing the spreadsheet title");
    if (title !== EXPECTED_BUS_ROUTES_SHEET_TITLE) {
      throw new Error(`Connected spreadsheet title must be exactly "${EXPECTED_BUS_ROUTES_SHEET_TITLE}"`);
    }
    return {
      configured: true,
      connected: true,
      spreadsheetTitle: title,
      requiredTitle: EXPECTED_BUS_ROUTES_SHEET_TITLE,
      availableSheets: (metadata.sheets ?? [])
        .filter((sheet) => !sheet.properties?.hidden)
        .map((sheet) => sheet.properties?.title)
        .filter((name): name is string => !!name),
      error: null,
    };
  } catch (error) {
    return {
      configured: true,
      connected: false,
      spreadsheetTitle: null,
      requiredTitle: EXPECTED_BUS_ROUTES_SHEET_TITLE,
      availableSheets: [],
      error: error instanceof Error ? error.message : "Google Sheets connection failed",
    };
  }
}