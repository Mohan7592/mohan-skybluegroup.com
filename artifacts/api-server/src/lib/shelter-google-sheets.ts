import { ReplitConnectors } from "@replit/connectors-sdk";

export const EXPECTED_SHELTER_SHEET_TITLE = "BUS SHELTER MASTER FILE_Updated";
export const SHELTER_SOURCE_SHEETS = ["Single", "Double"] as const;

export type ShelterSheetName = typeof SHELTER_SOURCE_SHEETS[number];
export type SheetRow = Record<string, unknown>;
export const SHELTER_REQUIRED_HEADERS: Record<ShelterSheetName, string[]> = {
  Single: [
    "Accountability", "Power-STATUS", "Light Type", "Type", "Single Shelters Area",
    "Shelter No", "Bus Route", "Single Shelters Bus Stop Name", "Coordinates",
    "Mupi", "Google link", "Not yet confirmed", "Clients", "Artwork", "Remark",
    "Stard date", "End Date",
  ],
  Double: [
    "Accountability", "Power-Status106", "Light Type", "Type", "Double Shelters Area",
    "Shelter No", "Bus Route", "Double Shelters Bus Stop Name", "Coordinates",
    "Mupi", "Google link", "Clients", "Not Yet Confirmed", "Remarks",
    "Stard Date", "End Date",
  ],
};

type SheetsMetadata = {
  properties?: { title?: string };
  sheets?: Array<{ properties?: { title?: string; hidden?: boolean } }>;
};

type ValuesResponse = {
  valueRanges?: Array<{ range?: string; values?: unknown[][] }>;
};

function sheetId(): string {
  const id = process.env.SHELTER_MASTER_SHEET_ID?.trim();
  if (!id) throw new Error("SHELTER_MASTER_SHEET_ID is not configured");
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

export async function getShelterSpreadsheetMetadata(): Promise<{
  title: string;
  availableSheets: string[];
}> {
  const connectors = new ReplitConnectors();
  const spreadsheet = await readJson<SheetsMetadata>(
    connectors,
    `/v4/spreadsheets/${encodeURIComponent(sheetId())}?fields=properties.title,sheets.properties(title,hidden)`,
  );
  const title = spreadsheet.properties?.title;
  if (!title) throw new Error("Google Sheets response is missing the spreadsheet title");
  if (title !== EXPECTED_SHELTER_SHEET_TITLE) {
    throw new Error(`Connected spreadsheet title must be exactly "${EXPECTED_SHELTER_SHEET_TITLE}"`);
  }
  const availableSheets = (spreadsheet.sheets ?? [])
    .map((sheet) => sheet.properties?.title)
    .filter((name): name is string => !!name);
  for (const requiredName of SHELTER_SOURCE_SHEETS) {
    if (!availableSheets.includes(requiredName)) {
      throw new Error(`Google Sheet is missing the required "${requiredName}" tab`);
    }
    if (spreadsheet.sheets?.find((sheet) => sheet.properties?.title === requiredName)?.properties?.hidden) {
      throw new Error(`The required "${requiredName}" tab is hidden; no inventory was changed`);
    }
  }
  return { title, availableSheets };
}

function cellText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  throw new Error("Google Sheet contains a non-scalar cell value");
}

export function rowsFromValues(values: unknown[][] | undefined, sheetName: ShelterSheetName): SheetRow[] {
  if (!Array.isArray(values) || values.length < 2) {
    throw new Error(`The "${sheetName}" tab is empty or unreadable`);
  }
  const headers = values[0]?.map((header) => cellText(header).trim());
  if (!headers?.some((header) => header.length > 0)) {
    throw new Error(`The "${sheetName}" tab does not have a readable header row`);
  }
  const foundHeaders = new Set(headers.map(normalizeHeader));
  const missing = SHELTER_REQUIRED_HEADERS[sheetName]
    .filter((header) => !foundHeaders.has(normalizeHeader(header)));
  if (missing.length) {
    throw new Error(`The "${sheetName}" tab is missing required source columns: ${missing.join(", ")}`);
  }
  return values.slice(1).map((cells) => {
    const row: SheetRow = {};
    headers.forEach((header, index) => {
      const value = cells?.[index];
      if (value != null) cellText(value);
      if (header) row[header] = value ?? "";
    });
    return row;
  }).filter((row) => String(findColumn(row, ["Shelter No"]) ?? "").trim().length > 0);
}

function normalizeHeader(value: string): string {
  return value.toLocaleLowerCase().replace(/[^a-z0-9]/g, "");
}

function findColumn(row: SheetRow, candidateNames: string[]): unknown {
  const candidateKeys = new Set(candidateNames.map(normalizeHeader));
  for (const [header, value] of Object.entries(row)) {
    if (candidateKeys.has(normalizeHeader(header))) return value;
  }
  return undefined;
}

export async function readShelterSourceSheets(): Promise<{
  title: string;
  sheets: Record<ShelterSheetName, SheetRow[]>;
}> {
  const connectors = new ReplitConnectors();
  const { title } = await getShelterSpreadsheetMetadata();
  const ranges = SHELTER_SOURCE_SHEETS.map((name) => `ranges=${encodeURIComponent(`'${name}'`)}`).join("&");
  const result = await readJson<ValuesResponse>(
    connectors,
    `/v4/spreadsheets/${encodeURIComponent(sheetId())}/values:batchGet?${ranges}&majorDimension=ROWS`,
  );
  if (!Array.isArray(result.valueRanges) || result.valueRanges.length !== SHELTER_SOURCE_SHEETS.length) {
    throw new Error("Google Sheets returned incomplete tab data");
  }
  const byRange = new Map(result.valueRanges.map((entry) => {
    const rangeName = entry.range?.replaceAll("'", "").split("!")[0];
    return [rangeName, entry.values] as const;
  }));
  const sheets = {} as Record<ShelterSheetName, SheetRow[]>;
  for (const name of SHELTER_SOURCE_SHEETS) {
    const values = byRange.get(name);
    if (!values) throw new Error(`Google Sheets did not return the "${name}" tab`);
    sheets[name] = rowsFromValues(values, name);
  }
  return { title, sheets };
}

export async function getSheetConnectionStatus(): Promise<{
  connected: boolean;
  configured: boolean;
  spreadsheetTitle: string | null;
  requiredTitle: string;
  availableSheets: string[];
  error: string | null;
}> {
  const configured = !!process.env.SHELTER_MASTER_SHEET_ID?.trim();
  if (!configured) {
    return {
      connected: false,
      configured: false,
      spreadsheetTitle: null,
      requiredTitle: EXPECTED_SHELTER_SHEET_TITLE,
      availableSheets: [],
      error: "SHELTER_MASTER_SHEET_ID is not configured",
    };
  }
  try {
    const metadata = await getShelterSpreadsheetMetadata();
    return {
      connected: true,
      configured: true,
      spreadsheetTitle: metadata.title,
      requiredTitle: EXPECTED_SHELTER_SHEET_TITLE,
      availableSheets: metadata.availableSheets,
      error: null,
    };
  } catch (error) {
    return {
      connected: false,
      configured: true,
      spreadsheetTitle: null,
      requiredTitle: EXPECTED_SHELTER_SHEET_TITLE,
      availableSheets: [],
      error: error instanceof Error ? error.message : "Google Sheets connection failed",
    };
  }
}

export const shelterSheetInternals = { findColumn, normalizeHeader };