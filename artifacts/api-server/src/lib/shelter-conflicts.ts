import { ReplitConnectors } from "@replit/connectors-sdk";
import {
  getShelterSpreadsheetMetadata,
  rowsFromValues,
  SHELTER_SOURCE_SHEETS,
  type ShelterSheetName,
} from "./shelter-google-sheets";
import { parseShelterSourceRow } from "./shelter-source-rules";

export type ShelterConflictRow = {
  sourceRow: number;
  area: string | null;
  stopName: string | null;
  coordinates: string | null;
  type: string | null;
  accountability: string | null;
  removalStatus: string;
  client: string | null;
  remarks: string | null;
};

export type ShelterConflict = {
  sourceKey: string;
  sheet: ShelterSheetName;
  shelterNumber: string;
  rows: ShelterConflictRow[];
  resolutionOptions: string[];
};

const RESOLUTION_OPTIONS = ["Keep Row A", "Keep Row B", "Merge", "Keep unresolved"];

export function shelterConflictsFromValues(
  sheets: Record<ShelterSheetName, unknown[][]>,
): ShelterConflict[] {
  const groups = new Map<string, ShelterConflict>();
  for (const sheet of SHELTER_SOURCE_SHEETS) {
    const values = sheets[sheet];
    if (!Array.isArray(values) || values.length < 2) {
      throw new Error(`The "${sheet}" tab is empty or unreadable`);
    }
    for (let index = 1; index < values.length; index++) {
      // Parse a single source row with the existing header rules, without modifying
      // the shelter sync's row shape or accidentally treating a blank ID as an asset.
      const [row] = rowsFromValues([values[0], values[index]], sheet);
      if (!row) continue;
      const parsed = parseShelterSourceRow(sheet, row);
      if (!parsed) continue;
      let group = groups.get(parsed.sourceKey);
      if (!group) {
        group = {
          sourceKey: parsed.sourceKey,
          sheet,
          shelterNumber: parsed.shelterNumber,
          rows: [],
          resolutionOptions: RESOLUTION_OPTIONS,
        };
        groups.set(parsed.sourceKey, group);
      }
      group.rows.push({
        sourceRow: index + 1,
        area: parsed.values.area ?? null,
        stopName: parsed.values.stopName ?? null,
        coordinates: parsed.values.coordinatesRaw ?? null,
        type: parsed.values.assetTypeOriginal ?? null,
        accountability: parsed.values.accountability ?? null,
        removalStatus: parsed.values.sourceLifecycleStatus ?? "ACTIVE",
        client: parsed.values.currentClientRaw ?? parsed.values.tentativeClient ?? null,
        remarks: parsed.values.remarks ?? null,
      });
    }
  }
  return [...groups.values()].filter((group) => group.rows.length > 1)
    .sort((a, b) => a.sourceKey.localeCompare(b.sourceKey));
}

let cache: { sheetId: string; expiresAt: number; conflicts: ShelterConflict[] } | null = null;

export async function readShelterConflicts(): Promise<ShelterConflict[]> {
  const sheetId = process.env.SHELTER_MASTER_SHEET_ID?.trim();
  if (!sheetId) throw new Error("SHELTER_MASTER_SHEET_ID is not configured");
  if (cache?.sheetId === sheetId && cache.expiresAt > Date.now()) return cache.conflicts;
  await getShelterSpreadsheetMetadata();
  const connectors = new ReplitConnectors();
  const ranges = SHELTER_SOURCE_SHEETS.map((name) => `ranges=${encodeURIComponent(`'${name}'`)}`).join("&");
  const response = await connectors.proxy(
    "google-sheet",
    `/v4/spreadsheets/${encodeURIComponent(sheetId)}/values:batchGet?${ranges}&majorDimension=ROWS`,
  );
  if (!response.ok) throw new Error(`Google Sheets request failed (${response.status})`);
  const result = await response.json() as {
    valueRanges?: Array<{ range?: string; values?: unknown[][] }>;
  };
  if (!Array.isArray(result.valueRanges) || result.valueRanges.length !== SHELTER_SOURCE_SHEETS.length) {
    throw new Error("Google Sheets returned incomplete tab data");
  }
  const sheets = {} as Record<ShelterSheetName, unknown[][]>;
  for (const name of SHELTER_SOURCE_SHEETS) {
    const values = result.valueRanges.find((entry) =>
      entry.range?.replaceAll("'", "").split("!")[0] === name)?.values;
    if (!values) throw new Error(`Google Sheets did not return the "${name}" tab`);
    sheets[name] = values;
  }
  const conflicts = shelterConflictsFromValues(sheets);
  cache = { sheetId, expiresAt: Date.now() + 60_000, conflicts };
  return conflicts;
}