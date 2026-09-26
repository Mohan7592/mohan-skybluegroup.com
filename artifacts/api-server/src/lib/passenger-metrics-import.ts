export type RouteMappingStatus = "MATCHED_VARIANT" | "ROUTE_LEVEL_ONLY" | "UNMATCHED" | "CONFLICT";
export type PassengerImportMapping = {
  routeIdentifier: string;
  month: string;
  passengers: string;
  trips?: string | null;
  routeVariant?: string | null;
};
export type PassengerRouteCandidate = {
  id: string;
  routeId: string;
  sourceVariantId?: string;
  sourceIdentity?: string;
  sourceSheet?: string;
  sourceRow?: number;
  from?: string | null;
  to?: string | null;
  via?: string | null;
  sourceBusCount?: number | null;
};
export type PassengerRouteTarget = PassengerRouteCandidate & { normalizedRouteId?: string };
export type PassengerImportRow = {
  sourceRouteIdentifier: string;
  normalizedSourceRouteIdentifier: string;
  sourceVariantIdentifier: string | null;
  sourceValues: Record<string, string>;
  month: string;
  passengerCount: number;
  tripCount: number | null;
  sourceRow: number;
  mappingStatus: RouteMappingStatus;
  busRouteId: string | null;
  sourceVariantId: string | null;
  matchedRouteId: string | null;
  routeCandidates: PassengerRouteCandidate[];
  error: string | null;
};

const MAX_CSV_CHARACTERS = 20_000_000;
const MAX_CSV_ROWS = 20_000;
const MAX_CSV_COLUMNS = 100;
const MAX_DATABASE_INTEGER = 2_147_483_647;

export function normalizePassengerRouteIdentifier(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

function compactRouteIdentifier(value: string): string {
  return normalizePassengerRouteIdentifier(value).replace(/[^a-z0-9]/g, "");
}

export function parseCsvRecords(csv: string): { headers: string[]; rows: Array<{ values: Record<string, string>; sourceRow: number }> } {
  if (csv.length > MAX_CSV_CHARACTERS) throw new Error("CSV exceeds the 20 MB import limit.");
  const records: string[][] = [];
  let record: string[] = [];
  let cell = "";
  let quoted = false;
  let endedCell = false;
  for (let i = 0; i < csv.length; i += 1) {
    const char = csv[i]!;
    if (quoted) {
      if (char === "\"") {
        if (csv[i + 1] === "\"") { cell += "\""; i += 1; }
        else { quoted = false; endedCell = true; }
      } else cell += char;
      continue;
    }
    if (char === ",") {
      if (record.length >= MAX_CSV_COLUMNS) throw new Error(`CSV exceeds the ${MAX_CSV_COLUMNS}-column limit.`);
      record.push(cell);
      cell = "";
      endedCell = false;
      continue;
    }
    if (char === "\n" || char === "\r") {
      if (record.length >= MAX_CSV_COLUMNS) throw new Error(`CSV exceeds the ${MAX_CSV_COLUMNS}-column limit.`);
      record.push(cell);
      if (record.some((value) => value.trim())) records.push(record);
      record = [];
      cell = "";
      endedCell = false;
      if (char === "\r" && csv[i + 1] === "\n") i += 1;
      continue;
    }
    if (char === "\"" && !cell.length && !endedCell) {
      quoted = true;
      continue;
    }
    if (endedCell && !/\s/.test(char)) throw new Error(`Unexpected text after a quoted field near CSV character ${i + 1}.`);
    if (!endedCell) cell += char;
  }
  if (quoted) throw new Error("CSV has an unterminated quoted field.");
  if (cell.length || record.length) {
    if (record.length >= MAX_CSV_COLUMNS) throw new Error(`CSV exceeds the ${MAX_CSV_COLUMNS}-column limit.`);
    record.push(cell);
    if (record.some((value) => value.trim())) records.push(record);
  }
  if (!records.length) throw new Error("CSV is empty.");
  const headers = records[0]!.map((header, index) => (index === 0 ? header.replace(/^\uFEFF/, "") : header).trim());
  if (headers.some((header) => !header)) throw new Error("CSV contains an empty column header.");
  if (new Set(headers.map((header) => header.toLocaleLowerCase("en-US"))).size !== headers.length) {
    throw new Error("CSV contains duplicate column headers. Rename the duplicates and try again.");
  }
  const normalizedHeaders = headers.map((header) => header.normalize("NFKC")
    .toLocaleLowerCase("en-US").replace(/[^a-z0-9]/g, ""));
  if (new Set(normalizedHeaders).size !== normalizedHeaders.length) {
    throw new Error("CSV contains column headers that normalize to the same field. Rename the duplicates and try again.");
  }
  if (records.length - 1 > MAX_CSV_ROWS) throw new Error(`CSV exceeds the ${MAX_CSV_ROWS.toLocaleString()} row import limit.`);
  const dataRecords = records.slice(1);
  const overwideRow = dataRecords.findIndex((values) => values.length > headers.length);
  if (overwideRow >= 0) {
    throw new Error(`CSV source row ${overwideRow + 2} contains more fields than its header; no row values were retained.`);
  }
  return {
    headers,
    rows: dataRecords.map((values, index) => ({
      values: Object.fromEntries(headers.map((header, columnIndex) => [header, values[columnIndex] ?? ""])),
      sourceRow: index + 2,
    })),
  };
}

export function parseCsvHeader(csv: string): string[] {
  let quoted = false;
  let end = csv.length;
  for (let i = 0; i < csv.length; i += 1) {
    if (csv[i] === "\"") {
      if (quoted && csv[i + 1] === "\"") { i += 1; continue; }
      quoted = !quoted;
    } else if (!quoted && (csv[i] === "\n" || csv[i] === "\r")) {
      end = i;
      break;
    }
  }
  if (quoted) throw new Error("CSV has an unterminated quoted header.");
  return parseCsvRecords(csv.slice(0, end)).headers;
}

export function validatePassengerRidershipHeaders(headers: string[], mapping: PassengerImportMapping): void {
  const headerFor = (selected: string) => headers.find((header) => header === selected);
  const compactHeader = (value: string) => value.normalize("NFKC").toLocaleLowerCase("en-US").replace(/[^a-z0-9]/g, "");
  const routeHeader = headerFor(mapping.routeIdentifier) ?? "";
  const monthHeader = headerFor(mapping.month) ?? "";
  const passengerHeader = headerFor(mapping.passengers) ?? "";
  const tripHeader = mapping.trips ? headerFor(mapping.trips) ?? "" : "";
  const compactHeaders = headers.map(compactHeader);
  const forbidden = compactHeaders.some((header) =>
    /employee|personnel|swipe|access|card|badge|user|person|staff|driver|operator|event|login|logout|clock|checkin|checkout|journey|mobiledevice|signedin|signedout|permissionreason|dooraddress|email|phone|contact|passport|nationalid|latitude|longitude|gps|device|remarks|reason/.test(header) ||
    /(?:^|route)name$/.test(header) ||
    /^(?:name|address|mobile)$/.test(header) ||
    (/id/.test(header) && !/route|trip|variant|service|identity/.test(header)));
  if (forbidden) throw new Error("This file appears to contain personnel or access-event data; only route-wise passenger ridership CSV files can be imported.");
  const routeColumn = compactHeader(routeHeader);
  const monthColumn = compactHeader(monthHeader);
  const passengerColumn = compactHeader(passengerHeader);
  const tripColumn = compactHeader(tripHeader);
  if (!(routeColumn.includes("route") || /^line(?:id|no|number|code)?$/.test(routeColumn) || routeColumn.startsWith("serviceid")) ||
      !(monthColumn.includes("month") || monthColumn.includes("period")) ||
      !(passengerColumn.includes("passenger") || passengerColumn.includes("ridership") || passengerColumn.includes("pax")) ||
      (tripHeader && !(/^trips?(?:count|number)?$/.test(tripColumn) || tripColumn.startsWith("trip")))) {
    throw new Error("Selected columns must identify a route, reporting month/period, and passenger/ridership count; trips are optional.");
  }
}

export function normalizePassengerMonth(value: string): string | null {
  const input = value.trim();
  let year: number;
  let month: number;
  let match = /^(\d{4})[-/](\d{1,2})(?:[-/]\d{1,2})?$/.exec(input);
  if (match) {
    year = Number(match[1]);
    month = Number(match[2]);
  } else if ((match = /^(\d{1,2})[-/](\d{4})$/.exec(input))) {
    month = Number(match[1]);
    year = Number(match[2]);
  } else if ((match = /^([A-Za-z]{3,9})[\s-]+(\d{4})$/.exec(input))) {
    month = new Date(`${match[1]} 1, 2000`).getMonth() + 1;
    year = Number(match[2]);
  } else if ((match = /^(\d{4})[\s-]+([A-Za-z]{3,9})$/.exec(input))) {
    year = Number(match[1]);
    month = new Date(`${match[2]} 1, 2000`).getMonth() + 1;
  } else return null;
  return Number.isInteger(year) && year >= 1900 && year <= 2200 &&
    Number.isInteger(month) && month >= 1 && month <= 12
    ? `${year}-${String(month).padStart(2, "0")}`
    : null;
}

function countValue(value: string, optional: boolean): number | null | undefined {
  const trimmed = value.trim();
  if (!trimmed) return optional ? null : undefined;
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(trimmed)) return undefined;
  const count = Number(trimmed.replaceAll(",", ""));
  return Number.isSafeInteger(count) && count <= MAX_DATABASE_INTEGER ? count : undefined;
}

export function previewPassengerMetricsCsv(
  csv: string,
  mapping: PassengerImportMapping,
  sourceFile: string,
  routes: PassengerRouteTarget[],
): { headers: string[]; sourceFile: string; rows: PassengerImportRow[]; summary: Record<RouteMappingStatus | "INVALID", number> } {
  const headers = parseCsvHeader(csv);
  const missing = [mapping.routeIdentifier, mapping.month, mapping.passengers, mapping.trips, mapping.routeVariant]
    .filter((header): header is string => !!header && !headers.includes(header));
  if (missing.length) throw new Error(`Selected column(s) were not found in the CSV: ${missing.join(", ")}.`);
  validatePassengerRidershipHeaders(headers, mapping);
  const parsed = parseCsvRecords(csv);
  const exact = new Map<string, PassengerRouteTarget[]>();
  const compact = new Map<string, PassengerRouteTarget[]>();
  for (const route of routes) {
    if (!route.routeId.trim()) continue;
    for (const identifier of new Set([route.routeId, route.normalizedRouteId ?? route.routeId])) {
      const normalized = normalizePassengerRouteIdentifier(identifier);
      exact.set(normalized, [...(exact.get(normalized) ?? []), route]);
      const compactIdentifier = compactRouteIdentifier(identifier);
      if (compactIdentifier) compact.set(compactIdentifier, [...(compact.get(compactIdentifier) ?? []), route]);
    }
  }
  const uniqueTargets = (values: PassengerRouteTarget[]): PassengerRouteCandidate[] =>
    [...new Map(values.map((route) => [route.sourceVariantId ?? route.id, route])).values()]
      .map(({ id, routeId, sourceVariantId, sourceIdentity, sourceSheet, sourceRow, from, to, via, sourceBusCount }) => ({
        id, routeId, sourceVariantId, sourceIdentity, sourceSheet, sourceRow, from, to, via, sourceBusCount,
      }));
  const rows = markPassengerRouteMonthConflicts(parsed.rows.map(({ values, sourceRow }): PassengerImportRow => {
    const sourceRouteIdentifier = (values[mapping.routeIdentifier] ?? "").trim();
    const normalizedSourceRouteIdentifier = normalizePassengerRouteIdentifier(sourceRouteIdentifier);
    const month = normalizePassengerMonth(values[mapping.month] ?? "");
    const passengerCount = countValue(values[mapping.passengers] ?? "", false);
    const tripCount = mapping.trips ? countValue(values[mapping.trips] ?? "", true) : null;
    const sourceVariantIdentifier = mapping.routeVariant ? (values[mapping.routeVariant] ?? "").trim() : "";
    const errors: string[] = [];
    if (!sourceRouteIdentifier) errors.push("Route identifier is blank.");
    if (!month) errors.push("Month is not a supported month/date value.");
    if (passengerCount === undefined) errors.push("Passenger count must be a whole number from 0 to 2,147,483,647.");
    if (mapping.trips && tripCount === undefined) errors.push("Trip count must be a whole number from 0 to 2,147,483,647 or blank.");
    if (errors.length) {
      return {
        sourceRouteIdentifier,
        normalizedSourceRouteIdentifier,
        sourceVariantIdentifier: sourceVariantIdentifier || null,
        sourceValues: values,
        month: month ?? "",
        passengerCount: typeof passengerCount === "number" ? passengerCount : 0,
        tripCount: typeof tripCount === "number" ? tripCount : null,
        sourceRow,
        mappingStatus: "UNMATCHED",
        busRouteId: null,
        sourceVariantId: null,
        matchedRouteId: null,
        routeCandidates: [],
        error: errors.join(" "),
      };
    }
    let exactMatches = uniqueTargets(exact.get(normalizedSourceRouteIdentifier) ?? []);
    const routeExactMatches = exactMatches;
    let candidates = exactMatches.length
      ? exactMatches
      : uniqueTargets(compact.get(compactRouteIdentifier(sourceRouteIdentifier)) ?? []);
    if (mapping.routeVariant && sourceVariantIdentifier) {
      const normalizedVariant = normalizePassengerRouteIdentifier(sourceVariantIdentifier);
      const variantMatches = candidates.filter((candidate) => [
        candidate.sourceVariantId ?? "",
        candidate.sourceIdentity ?? "",
        candidate.sourceSheet ?? "",
        candidate.sourceRow == null ? "" : String(candidate.sourceRow),
      ].some((value) => normalizePassengerRouteIdentifier(value) === normalizedVariant));
      if (variantMatches.length) {
        candidates = variantMatches;
        exactMatches = variantMatches;
      } else {
        exactMatches = [];
      }
    }
    const directMatches = exactMatches;
    const candidateFamilies = new Map(candidates.map((candidate) => [candidate.id, candidate]));
    const singleFamily = routeExactMatches.length > 0 && candidateFamilies.size === 1
      ? [...candidateFamilies.values()][0] ?? null
      : null;
    const directVariant = directMatches.length === 1 && directMatches[0]?.sourceVariantId
      ? directMatches[0]
      : null;
    const mappingStatus: RouteMappingStatus = directVariant
      ? "MATCHED_VARIANT"
      : singleFamily ? "ROUTE_LEVEL_ONLY" : "UNMATCHED";
    const mapped = directVariant ?? singleFamily;
    return {
      sourceRouteIdentifier,
      normalizedSourceRouteIdentifier,
      sourceVariantIdentifier: sourceVariantIdentifier || null,
      sourceValues: values,
      month: month!,
      passengerCount: passengerCount as number,
      tripCount: tripCount as number | null,
      sourceRow,
      mappingStatus,
      busRouteId: mapped?.id ?? null,
      sourceVariantId: mappingStatus === "MATCHED_VARIANT" ? mapped?.sourceVariantId ?? null : null,
      matchedRouteId: mapped?.routeId ?? null,
      routeCandidates: candidates,
      error: null,
    };
  }));
  const summary = { MATCHED_VARIANT: 0, ROUTE_LEVEL_ONLY: 0, UNMATCHED: 0, CONFLICT: 0, INVALID: 0 };
  for (const row of rows) summary[row.error ? "INVALID" : row.mappingStatus] += 1;
  return { headers: parsed.headers, sourceFile, rows, summary };
}

export function summarizePassengerMappingStatuses(rows: Array<Pick<PassengerImportRow, "mappingStatus" | "error">>) {
  const summary = { MATCHED_VARIANT: 0, ROUTE_LEVEL_ONLY: 0, UNMATCHED: 0, CONFLICT: 0, INVALID: 0 };
  for (const row of rows) summary[row.error ? "INVALID" : row.mappingStatus] += 1;
  return summary;
}

type PassengerRouteMonthIdentity = {
  normalizedSourceRouteIdentifier: string;
  month: string;
  passengerCount: number;
  mappingStatus: RouteMappingStatus;
};

export function passengerRouteMonthKey(row: Pick<PassengerRouteMonthIdentity, "normalizedSourceRouteIdentifier" | "month">): string {
  return JSON.stringify([row.normalizedSourceRouteIdentifier, row.month]);
}

export function isPassengerRouteMonthConflictEligible(
  row: Pick<PassengerRouteMonthIdentity, "normalizedSourceRouteIdentifier" | "month">,
): boolean {
  return !!row.normalizedSourceRouteIdentifier.trim() && /^\d{4}-(0[1-9]|1[0-2])$/.test(row.month);
}

export function reconcilePassengerRouteMonthConflicts<
  T extends PassengerRouteMonthIdentity & {
    error?: string | null;
    busRouteId: string | null;
    sourceVariantId: string | null;
    matchedRouteId: string | null;
  },
>(
  incomingRows: T[],
  existingRows: PassengerRouteMonthIdentity[],
): { rows: T[]; conflictKeys: Set<string> } {
  const counts = new Map<string, Set<number>>();
  const statuses = new Map<string, RouteMappingStatus[]>();
  for (const row of [...existingRows, ...incomingRows]) {
    if (("error" in row && row.error) || !isPassengerRouteMonthConflictEligible(row)) continue;
    const key = passengerRouteMonthKey(row);
    counts.set(key, new Set([...(counts.get(key) ?? []), row.passengerCount]));
    statuses.set(key, [...(statuses.get(key) ?? []), row.mappingStatus]);
  }
  const conflictKeys = new Set([...counts.keys()].filter((key) =>
    (counts.get(key)?.size ?? 0) > 1 ||
    statuses.get(key)?.includes("CONFLICT") === true));
  return {
    rows: incomingRows.map((row) => {
      if (!conflictKeys.has(passengerRouteMonthKey(row))) return row;
      return {
        ...row,
        mappingStatus: "CONFLICT" as const,
        busRouteId: null,
        sourceVariantId: null,
        matchedRouteId: null,
      };
    }),
    conflictKeys,
  };
}

export function markPassengerRouteMonthConflicts<T extends PassengerRouteMonthIdentity & {
  error: string | null;
  normalizedSourceRouteIdentifier: string;
  busRouteId: string | null;
  sourceVariantId: string | null;
  matchedRouteId: string | null;
}>(rows: T[]): T[] {
  return reconcilePassengerRouteMonthConflicts(rows, []).rows;
}

function csvCell(value: string): string {
  return `"${value.replaceAll("\"", "\"\"")}"`;
}

/**
 * Adapter for the RTA "Bus Passengers Trips by Route Monthly" export.
 * The caller must explicitly attest that the source's `trips` field means
 * passenger journeys, not scheduled vehicle trips.
 */
export function previewRtaPassengerJourneysCsv(
  csv: string,
  sourceFile: string,
  routes: PassengerRouteTarget[],
  options: { passengerJourneys: boolean },
): ReturnType<typeof previewPassengerMetricsCsv> {
  if (!options.passengerJourneys) {
    throw new Error("Refusing to interpret `trips` as passenger journeys without the explicit --passenger-journeys flag.");
  }

  const original = parseCsvRecords(csv);
  const compactHeader = (value: string) => value.normalize("NFKC").toLocaleLowerCase("en-US").replace(/[^a-z0-9]/g, "");
  const headerByName = new Map(original.headers.map((header) => [compactHeader(header), header]));
  const monthHeader = headerByName.get("month");
  const routeHeader = headerByName.get("routename");
  const journeyHeader = headerByName.get("trips");
  const yearHeader = headerByName.get("year");
  if (!monthHeader || !routeHeader || !journeyHeader || !yearHeader) {
    throw new Error("Expected RTA monthly passenger-trip columns: month, route_name, trips, and year.");
  }

  const missingRouteToken = (sourceRow: number) => `__missing_route_row_${sourceRow}__`;
  const adapted = [
    ["route_identifier", "reporting_month", "passenger_count"],
    ...original.rows.map(({ values, sourceRow }) => {
      const month = normalizePassengerMonth(`${values[monthHeader] ?? ""} ${values[yearHeader] ?? ""}`) ?? "";
      const route = (values[routeHeader] ?? "").trim();
      return [
        route || missingRouteToken(sourceRow),
        month,
        values[journeyHeader] ?? "",
      ];
    }),
  ].map((row) => row.map(csvCell).join(",")).join("\n");
  const mapping: PassengerImportMapping = {
    routeIdentifier: "route_identifier",
    month: "reporting_month",
    passengers: "passenger_count",
    trips: null,
    routeVariant: null,
  };
  const preview = previewPassengerMetricsCsv(adapted, mapping, sourceFile, routes);
  preview.headers = original.headers;
  preview.rows.forEach((row, index) => {
    row.sourceValues = original.rows[index]!.values;
    row.sourceRow = original.rows[index]!.sourceRow;
    row.tripCount = null;
    if (!(original.rows[index]!.values[routeHeader] ?? "").trim() && !row.error) {
      row.sourceRouteIdentifier = "";
      row.normalizedSourceRouteIdentifier = "";
      row.mappingStatus = "UNMATCHED";
      row.busRouteId = null;
      row.sourceVariantId = null;
      row.matchedRouteId = null;
      row.routeCandidates = [];
    }
  });
  const conflictAdjustedRows = markPassengerRouteMonthConflicts(preview.rows);
  preview.rows.splice(0, preview.rows.length, ...conflictAdjustedRows);
  preview.summary = summarizePassengerMappingStatuses(preview.rows);
  return preview;
}

export function summarizeSourcePeriodConflicts(rows: PassengerImportRow[]): {
  repeatedRouteMonths: number;
  conflictingRouteMonths: number;
  examples: Array<{ route: string; month: string; rows: number; distinctPassengerJourneyCounts: number }>;
} {
  const groups = new Map<string, PassengerImportRow[]>();
  for (const row of rows) {
    if (row.error || !row.sourceRouteIdentifier || !row.month) continue;
    const key = `${row.normalizedSourceRouteIdentifier}\u0000${row.month}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const repeated = [...groups.values()].filter((group) => group.length > 1);
  const conflicts = repeated.filter((group) => new Set(group.map((row) => row.passengerCount)).size > 1);
  return {
    repeatedRouteMonths: repeated.length,
    conflictingRouteMonths: conflicts.length,
    examples: [...conflicts, ...repeated.filter((group) => !conflicts.includes(group))]
      .slice(0, 10)
      .map((group) => ({
        route: group[0]!.sourceRouteIdentifier,
        month: group[0]!.month,
        rows: group.length,
        distinctPassengerJourneyCounts: new Set(group.map((row) => row.passengerCount)).size,
      })),
  };
}