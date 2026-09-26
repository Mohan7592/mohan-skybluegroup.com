import type { BusRouteSourceRowInput } from "./bus-routes-google-sheets";
import { busRouteStructuralIdentity } from "./bus-route-identity.js";

export function planBusRouteSourceRows(rows: BusRouteSourceRowInput[]) {
  const routes = new Set<string>();
  const identities = new Set<string>();
  for (const row of rows) {
    routes.add(row.normalizedRouteId);
    const identity = `${row.sheetName}\u0000${row.sourceIdentity}`;
    if (identities.has(identity)) {
      throw new Error(`Duplicate content source identity: ${row.sheetName} ${row.sourceIdentity}`);
    }
    identities.add(identity);
  }
  return { distinctRoutes: routes.size, sourceRows: rows.length, rowIdentities: identities };
}

export function reconcileBusRouteSourceIdentities(
  incomingRows: BusRouteSourceRowInput[],
  existingRows: Array<{
    sheetName: string;
    sourceIdentity: string;
    rawData: Record<string, unknown>;
  }>,
): void {
  const incomingByStructure = groupRows(incomingRows, (row) => `${row.sheetName}\u0000${row.structuralIdentity}`);
  const existingByStructure = groupRows(existingRows, (row) => {
    const routeId = fieldValue(row.rawData, "Route ID", "Route Number");
    return `${row.sheetName}\u0000${busRouteStructuralIdentity(row.sheetName, row.rawData, routeId)}`;
  });
  const structures = new Set([...incomingByStructure.keys(), ...existingByStructure.keys()]);

  for (const key of structures) {
    const current = incomingByStructure.get(key) ?? [];
    const previous = existingByStructure.get(key) ?? [];
    const previousByContent = groupRows(previous, (row) => stableJson(row.rawData));
    const currentByContent = groupRows(current, (row) => stableJson(row.rawData));
    const matchedIncoming = new Set<BusRouteSourceRowInput>();
    const matchedExisting = new Set<(typeof previous)[number]>();

    for (const [content, currentMatches] of currentByContent) {
      const previousMatches = previousByContent.get(content) ?? [];
      previousMatches.sort((a, b) => a.sourceIdentity.localeCompare(b.sourceIdentity));
      currentMatches.sort((a, b) => a.sourceRowNumber - b.sourceRowNumber);
      const matches = Math.min(currentMatches.length, previousMatches.length);
      for (let index = 0; index < matches; index++) {
        const incoming = currentMatches[index]!;
        const existing = previousMatches[index]!;
        incoming.sourceIdentity = existing.sourceIdentity;
        matchedIncoming.add(incoming);
        matchedExisting.add(existing);
      }
    }

    const unmatchedIncoming = current.filter((row) => !matchedIncoming.has(row));
    const unmatchedExisting = previous.filter((row) => !matchedExisting.has(row));
    if (unmatchedIncoming.length === 1 && unmatchedExisting.length === 1) {
      unmatchedIncoming[0]!.sourceIdentity = unmatchedExisting[0]!.sourceIdentity;
      continue;
    }
    if (unmatchedIncoming.length > 0 && unmatchedExisting.length > 0) {
      throw new Error(
        `Ambiguous duplicate bus-route variants in "${current[0]?.sheetName ?? previous[0]?.sheetName}"; source rows were not changed`,
      );
    }
  }
}

function groupRows<T>(rows: T[], keyOf: (row: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) groups.set(keyOf(row), [...(groups.get(keyOf(row)) ?? []), row]);
  return groups;
}

function fieldValue(rawData: Record<string, unknown>, ...fields: string[]): string {
  const normalized = new Set(fields.map((field) => field.toLocaleLowerCase().replace(/[^a-z0-9]/g, "")));
  for (const [header, value] of Object.entries(rawData)) {
    if (normalized.has(header.toLocaleLowerCase().replace(/[^a-z0-9]/g, ""))) return String(value ?? "").trim();
  }
  return "";
}

export function validateBusRouteSourceShrinkage(
  current: { sourceRows: number; discoveredSheets: Array<{ name: string; kind: "route" | "vehicle"; dataRows: number }> },
  previous: { sourceRows: number; discoveredSheets: Array<{ name: string; kind: "route" | "vehicle"; dataRows: number }> } | null,
): void {
  if (!previous || previous.sourceRows === 0) return;
  if (current.sourceRows * 2 < previous.sourceRows) {
    throw new Error(
      `Bus route source row count fell from ${previous.sourceRows} to ${current.sourceRows} (>50% shrink); manual review required`,
    );
  }
  const currentCounts = new Map(current.discoveredSheets
    .filter((sheet) => sheet.kind === "route")
    .map((sheet) => [sheet.name, sheet.dataRows]));
  for (const previousSheet of previous.discoveredSheets) {
    if (previousSheet.kind !== "route" || previousSheet.dataRows === 0) continue;
    const currentCount = currentCounts.get(previousSheet.name) ?? 0;
    if (currentCount * 2 < previousSheet.dataRows) {
      throw new Error(
        `Bus route tab "${previousSheet.name}" fell from ${previousSheet.dataRows} to ${currentCount} rows (>50% shrink); manual review required`,
      );
    }
  }
}

export function isSameBusRouteSourceRow(
  existing: { busRouteId: string; isActive: boolean; rawData: Record<string, unknown> },
  incoming: BusRouteSourceRowInput,
  routeDatabaseId: string,
): boolean {
  return existing.busRouteId === routeDatabaseId &&
    existing.isActive &&
    stableJson(existing.rawData) === stableJson(incoming.rawData);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}