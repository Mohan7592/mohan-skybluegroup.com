export type PassengerMonthObservation = {
  routeId: string;
  sourceVariantId: string | null;
  mappingStatus?: "MATCHED_VARIANT" | "ROUTE_LEVEL_ONLY" | "UNMATCHED" | "CONFLICT";
  period: string;
  passengerCount: number;
  tripCount: number | null;
  sourceFile: string;
  sourceRow: number;
  importedAt: string;
};

export type PassengerEvidenceSummary = Omit<PassengerRouteSeriesSummary, "sourceVariantId" | "passengerPercentile"> & {
  passengerPercentile: null;
  mappingStatus: "ROUTE_LEVEL_ONLY";
};

export type PassengerFamilyMonthObservation = Omit<PassengerMonthObservation, "sourceVariantId"> & {
  sourceVariantId?: null;
};

export const PASSENGER_MAPPING_STATUSES = [
  "MATCHED_VARIANT",
  "ROUTE_LEVEL_ONLY",
  "UNMATCHED",
  "CONFLICT",
] as const;

export type PassengerPeriodValue = {
  period: string;
  passengerCount: number;
  tripCount: number | null;
  passengersPerTrip: number | null;
  sourceFile: string;
  sourceRow: number;
};

export type PassengerRouteSeriesSummary = {
  routeId: string;
  sourceVariantId: string;
  latest: PassengerPeriodValue | null;
  previous: PassengerPeriodValue | null;
  firstPeriod: string | null;
  lastPeriod: string | null;
  threeMonthAverage: number | null;
  threeMonthPeriods: number;
  sixMonthAverage: number | null;
  sixMonthPeriods: number;
  availableTotal: number | null;
  availablePeriods: number;
  duplicatePeriods: number;
  conflictingPeriods: number;
  passengerPercentile: number | null;
  activity: "REPORTED_PASSENGER_ACTIVITY" | "NO_ACTIVITY_REPORTED" | "NO_METRIC";
};

type ResolvedPeriod = PassengerMonthObservation & {
  duplicate: boolean;
  conflict: boolean;
};

function monthOrdinal(period: string): number {
  const [year, month] = period.split("-").map(Number);
  return year! * 12 + month! - 1;
}

function average(values: number[]): number | null {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : null;
}

function toPeriodValue(row: PassengerMonthObservation): PassengerPeriodValue {
  return {
    period: row.period,
    passengerCount: row.passengerCount,
    tripCount: row.tripCount,
    passengersPerTrip: row.tripCount !== null && row.tripCount > 0
      ? row.passengerCount / row.tripCount
      : null,
    sourceFile: row.sourceFile,
    sourceRow: row.sourceRow,
  };
}

export function analyzePassengerRouteSeries(
  observations: PassengerMonthObservation[],
): PassengerRouteSeriesSummary[] {
  const variants = new Map<string, PassengerMonthObservation[]>();
  const conflictedPeriods = new Set(observations
    .filter((row) => row.mappingStatus === "CONFLICT")
    .map((row) => `${row.routeId}\u0000${row.period}`));
  for (const row of observations) {
    if (row.mappingStatus && row.mappingStatus !== "MATCHED_VARIANT" ||
        conflictedPeriods.has(`${row.routeId}\u0000${row.period}`)) continue;
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(row.period) ||
        !Number.isSafeInteger(row.passengerCount) || row.passengerCount < 0 ||
        (row.tripCount !== null && (!Number.isSafeInteger(row.tripCount) || row.tripCount < 0)) ||
        !row.sourceVariantId) continue;
    const key = `${row.routeId}:${row.sourceVariantId}`;
    variants.set(key, [...(variants.get(key) ?? []), row]);
  }

  const byVariant = new Map<string, PassengerRouteSeriesSummary>();
  for (const [key, rows] of variants) {
    const periods = new Map<string, PassengerMonthObservation[]>();
    for (const row of rows) periods.set(row.period, [...(periods.get(row.period) ?? []), row]);
    const resolved: ResolvedPeriod[] = [];
    let duplicatePeriods = 0;
    let conflictingPeriods = 0;
    for (const [period, samePeriod] of periods) {
      if (samePeriod.length > 1) duplicatePeriods += 1;
      const signatures = new Set(samePeriod.map((row) => `${row.passengerCount}:${row.tripCount ?? "null"}`));
      const conflict = signatures.size > 1;
      if (conflict) {
        conflictingPeriods += 1;
        continue;
      }
      const row = [...samePeriod].sort((a, b) =>
        b.importedAt.localeCompare(a.importedAt) ||
        a.sourceFile.localeCompare(b.sourceFile) ||
        a.sourceRow - b.sourceRow)[0]!;
      resolved.push({ ...row, duplicate: samePeriod.length > 1, conflict: false });
    }
    resolved.sort((a, b) => b.period.localeCompare(a.period));
    const latest = resolved[0] ?? null;
    const previous = resolved[1] ?? null;
    const recent = (periodCount: number) => {
      if (!latest) return { mean: null, count: 0 };
      const lower = monthOrdinal(latest.period) - periodCount + 1;
      const rowsInWindow = resolved.filter((row) => {
        const ordinal = monthOrdinal(row.period);
        return ordinal >= lower && ordinal <= monthOrdinal(latest.period);
      });
      return { mean: average(rowsInWindow.map((row) => row.passengerCount)), count: rowsInWindow.length };
    };
    const three = recent(3);
    const six = recent(6);
    byVariant.set(key, {
      routeId: rows[0]!.routeId,
      sourceVariantId: rows[0]!.sourceVariantId!,
      latest: latest ? toPeriodValue(latest) : null,
      previous: previous ? toPeriodValue(previous) : null,
      firstPeriod: resolved.length ? resolved[resolved.length - 1]!.period : null,
      lastPeriod: latest?.period ?? null,
      threeMonthAverage: three.mean,
      threeMonthPeriods: three.count,
      sixMonthAverage: six.mean,
      sixMonthPeriods: six.count,
      availableTotal: resolved.length ? resolved.reduce((total, row) => total + row.passengerCount, 0) : null,
      availablePeriods: resolved.length,
      duplicatePeriods,
      conflictingPeriods,
      passengerPercentile: null,
      activity: !latest ? "NO_METRIC"
        : latest.passengerCount > 0 || (latest.tripCount ?? 0) > 0
          ? "REPORTED_PASSENGER_ACTIVITY" : "NO_ACTIVITY_REPORTED",
    });
  }

  const latestByPeriod = new Map<string, Array<{ key: string; count: number }>>();
  for (const [key, summary] of byVariant) {
    if (!summary.latest) continue;
    latestByPeriod.set(summary.latest.period, [
      ...(latestByPeriod.get(summary.latest.period) ?? []),
      { key, count: summary.latest.passengerCount },
    ]);
  }
  for (const values of latestByPeriod.values()) {
    const sorted = [...values].sort((a, b) => a.count - b.count || a.key.localeCompare(b.key));
    for (let index = 0; index < sorted.length; index += 1) {
      let first = index;
      let last = index;
      while (first > 0 && sorted[first - 1]!.count === sorted[index]!.count) first -= 1;
      while (last + 1 < sorted.length && sorted[last + 1]!.count === sorted[index]!.count) last += 1;
      const percentile = sorted.length < 2
        ? null
        : ((first + last) / 2) / (sorted.length - 1) * 100;
      const summary = byVariant.get(sorted[index]!.key)!;
      summary.passengerPercentile = percentile;
    }
  }
  return [...byVariant.values()].sort((a, b) =>
    a.routeId.localeCompare(b.routeId) || a.sourceVariantId.localeCompare(b.sourceVariantId));
}

export function analyzePassengerRouteFamilies(
  observations: PassengerFamilyMonthObservation[],
): PassengerEvidenceSummary[] {
  const conflictedPeriods = new Set(observations
    .filter((row) => row.mappingStatus === "CONFLICT")
    .map((row) => `${row.routeId}\u0000${row.period}`));
  const familyRows = observations
    .filter((row) => row.mappingStatus === "ROUTE_LEVEL_ONLY" && row.routeId &&
      !conflictedPeriods.has(`${row.routeId}\u0000${row.period}`))
    .map((row): PassengerMonthObservation => ({
      ...row,
      sourceVariantId: "__route_family__",
      mappingStatus: "MATCHED_VARIANT",
    }));
  return analyzePassengerRouteSeries(familyRows).map(({ sourceVariantId: _sourceVariantId, ...summary }) => ({
    ...summary,
    passengerPercentile: null,
    mappingStatus: "ROUTE_LEVEL_ONLY",
  }));
}

function periodAtOrdinal(ordinal: number): string {
  const year = Math.floor(ordinal / 12);
  const month = ordinal % 12 + 1;
  return `${year}-${String(month).padStart(2, "0")}`;
}

function monthLabel(period: string): string {
  const [year, month] = period.split("-").map(Number);
  const monthName = new Date(Date.UTC(year!, month! - 1, 1))
    .toLocaleString("en-US", { month: "short", timeZone: "UTC" });
  return `${monthName} ${year}`;
}

export function summarizePassengerMetricPeriods(periods: string[]) {
  const distinctMonths = [...new Set(periods.filter((period) =>
    /^\d{4}-(0[1-9]|1[0-2])$/.test(period)))].sort();
  const firstMonth = distinctMonths[0] ?? null;
  const lastMonth = distinctMonths.at(-1) ?? null;
  const missingMonths = firstMonth && lastMonth
    ? Array.from(
      { length: monthOrdinal(lastMonth) - monthOrdinal(firstMonth) + 1 },
      (_, index) => periodAtOrdinal(monthOrdinal(firstMonth) + index),
    ).filter((period) => !distinctMonths.includes(period))
    : [];
  const rangeLabel = firstMonth && lastMonth
    ? `${distinctMonths.length} months of data available within ${monthLabel(firstMonth)}–${monthLabel(lastMonth)}.`
    : "No valid passenger-data months are available.";
  return {
    distinctMonthCount: distinctMonths.length,
    availableMonths: distinctMonths,
    firstMonth,
    lastMonth,
    missingMonthCount: missingMonths.length,
    missingMonths,
    rangeLabel,
  };
}

type PassengerConflictInput = {
  importBatchId: string;
  sourceRouteIdentifier: string;
  normalizedSourceRouteIdentifier: string;
  month: string;
  passengerCount: number;
  sourceFile: string;
  sourceRow: number;
  mappingStatus: string;
};

export function buildPassengerConflictReviewTable(rows: PassengerConflictInput[]) {
  const groups = new Map<string, PassengerConflictInput[]>();
  for (const row of rows) {
    if (!row.normalizedSourceRouteIdentifier.trim() || !/^\d{4}-(0[1-9]|1[0-2])$/.test(row.month)) continue;
    const key = `${row.normalizedSourceRouteIdentifier}\u0000${row.month}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.values()]
    .filter((group) =>
      new Set(group.map((row) => row.passengerCount)).size > 1 ||
      group.some((row) => row.mappingStatus === "CONFLICT"))
    .map((group) => ({
      route: group[0]!.sourceRouteIdentifier,
      month: group[0]!.month,
      distinctPassengerCounts: [...new Set(group.map((row) => row.passengerCount))].sort((a, b) => a - b),
      rawRowReferences: group
        .map(({ importBatchId, sourceFile, sourceRow }) => ({ importBatchId, sourceFile, sourceRow }))
        .sort((a, b) => a.sourceFile.localeCompare(b.sourceFile) || a.sourceRow - b.sourceRow),
    }))
    .sort((a, b) => a.route.localeCompare(b.route) || a.month.localeCompare(b.month));
}

export function passengerImportQuality<T extends {
  sourceRow: number;
  sourceRouteIdentifier: string;
  mappingStatus: string;
  routeCandidates: Array<{ routeId: string; sourceSheet?: string; sourceRow?: number }>;
  month?: string;
}>(rows: T[]) {
  const periods = summarizePassengerMetricPeriods(rows.flatMap((row) => row.month ? [row.month] : []));
  const statusCounts = Object.fromEntries(PASSENGER_MAPPING_STATUSES.map((status) => [
    status,
    rows.filter((row) => row.mappingStatus === status).length,
  ])) as Record<(typeof PASSENGER_MAPPING_STATUSES)[number], number>;
  return {
    validRows: rows.length,
    statusCounts,
    periods,
    exampleMappings: rows.slice(0, 12).map((row) => ({
      sourceRow: row.sourceRow,
      sourceRouteIdentifier: row.sourceRouteIdentifier,
      status: row.mappingStatus,
      candidates: row.routeCandidates.slice(0, 8).map((candidate) => ({
        routeId: candidate.routeId,
        sourceSheet: candidate.sourceSheet ?? null,
        sourceRow: candidate.sourceRow ?? null,
      })),
    })),
  };
}