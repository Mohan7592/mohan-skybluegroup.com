import test from "node:test";
import assert from "node:assert/strict";
import {
  analyzePassengerRouteFamilies,
  analyzePassengerRouteSeries,
  buildPassengerConflictReviewTable,
  summarizePassengerMetricPeriods,
} from "./passenger-metrics-analysis.ts";

const row = (period, passengerCount, tripCount, sourceRow, sourceFile = "ridership.csv") => ({
  routeId: "R1",
  sourceVariantId: "variant-1",
  period,
  passengerCount,
  tripCount,
  sourceFile,
  sourceRow,
  importedAt: "2025-04-01T10:00:00.000Z",
});

test("summarizes latest, previous, calendar-window averages and only safe per-trip ratios", () => {
  const [summary] = analyzePassengerRouteSeries([
    row("2025-01", 100, 10, 2),
    row("2025-02", 200, 0, 3),
    row("2025-03", 300, 30, 4),
    row("2025-03", 300, 30, 4, "duplicate-copy.csv"),
  ]);
  assert.equal(summary.latest.period, "2025-03");
  assert.equal(summary.previous.period, "2025-02");
  assert.equal(summary.firstPeriod, "2025-01");
  assert.equal(summary.lastPeriod, "2025-03");
  assert.equal(summary.latest.passengersPerTrip, 10);
  assert.equal(summary.previous.passengersPerTrip, null);
  assert.equal(summary.threeMonthAverage, 200);
  assert.equal(summary.threeMonthPeriods, 3);
  assert.equal(summary.sixMonthAverage, 200);
  assert.equal(summary.availableTotal, 600);
  assert.equal(summary.availablePeriods, 3);
  assert.equal(summary.duplicatePeriods, 1);
  assert.equal(summary.conflictingPeriods, 0);
});

test("conflicting records for a route-month are reported and excluded, never added", () => {
  const [summary] = analyzePassengerRouteSeries([
    row("2025-01", 100, 10, 2),
    row("2025-02", 200, 20, 3),
    row("2025-02", 225, 20, 8, "second-source.csv"),
  ]);
  assert.equal(summary.latest.period, "2025-01");
  assert.equal(summary.previous, null);
  assert.equal(summary.conflictingPeriods, 1);
  assert.equal(summary.duplicatePeriods, 1);
  assert.equal(summary.availableTotal, 100);
  assert.equal(summary.availablePeriods, 1);
});

test("percentile compares only same-period passenger metrics and leaves singleton percentiles unavailable", () => {
  const summaries = analyzePassengerRouteSeries([
    row("2025-03", 100, 10, 2),
    { ...row("2025-03", 300, 30, 3), routeId: "R2", sourceVariantId: "variant-2" },
    { ...row("2025-02", 10, 2, 4), routeId: "R3", sourceVariantId: "variant-3" },
  ]);
  assert.equal(summaries.find((summary) => summary.routeId === "R1").passengerPercentile, 0);
  assert.equal(summaries.find((summary) => summary.routeId === "R2").passengerPercentile, 100);
  assert.equal(summaries.find((summary) => summary.routeId === "R3").passengerPercentile, null);
});

test("explicit CONFLICT status takes precedence over otherwise matched evidence for the same route-month", () => {
  const summaries = analyzePassengerRouteSeries([
    { ...row("2025-01", 100, 10, 2), mappingStatus: "MATCHED_VARIANT" },
    { ...row("2025-01", 140, 10, 3), mappingStatus: "CONFLICT", sourceVariantId: null },
    { ...row("2025-02", 200, 20, 4), mappingStatus: "MATCHED_VARIANT" },
  ]);
  assert.equal(summaries[0].latest.period, "2025-02");
  assert.equal(summaries[0].availableTotal, 200);
  assert.equal(summaries[0].availablePeriods, 1);
});

test("route-family observations deduplicate repeated months once and never create variant series", () => {
  const familyRows = [
    {
      routeId: "10",
      mappingStatus: "ROUTE_LEVEL_ONLY",
      period: "2025-01",
      passengerCount: 500,
      tripCount: null,
      sourceFile: "first.csv",
      sourceRow: 4,
      importedAt: "2025-04-01T10:00:00.000Z",
    },
    {
      routeId: "10",
      mappingStatus: "ROUTE_LEVEL_ONLY",
      period: "2025-01",
      passengerCount: 500,
      tripCount: null,
      sourceFile: "duplicate.csv",
      sourceRow: 9,
      importedAt: "2025-04-02T10:00:00.000Z",
    },
    {
      routeId: "10",
      mappingStatus: "ROUTE_LEVEL_ONLY",
      period: "2025-02",
      passengerCount: 700,
      tripCount: null,
      sourceFile: "second.csv",
      sourceRow: 5,
      importedAt: "2025-04-03T10:00:00.000Z",
    },
  ];
  const [summary] = analyzePassengerRouteFamilies(familyRows);
  assert.equal(summary.routeId, "10");
  assert.equal(summary.latest.period, "2025-02");
  assert.equal(summary.availablePeriods, 2);
  assert.equal(summary.availableTotal, 1200);
  assert.equal(summary.duplicatePeriods, 1);
  assert.equal(summary.mappingStatus, "ROUTE_LEVEL_ONLY");
  assert.equal("sourceVariantId" in summary, false);
});

test("month coverage lists gaps in calendar order without implying continuous coverage", () => {
  const coverage = summarizePassengerMetricPeriods(["2025-03", "2025-01", "2025-01", "invalid"]);
  assert.deepEqual(coverage.availableMonths, ["2025-01", "2025-03"]);
  assert.deepEqual(coverage.missingMonths, ["2025-02"]);
  assert.equal(coverage.rangeLabel, "2 months of data available within Jan 2025–Mar 2025.");
});

test("96-month reporting fixture shows 78 available months and the known 18 missing months", () => {
  const missingMonths = [
    "2020-01", "2020-04", "2021-10", "2022-02",
    "2022-04", "2022-05", "2022-06", "2022-07", "2022-08", "2022-09", "2022-10", "2022-11",
    "2023-01", "2023-10", "2023-11", "2024-03", "2024-11", "2025-09",
  ];
  const presentMonths = [];
  for (let year = 2018; year <= 2025; year += 1) {
    for (let month = 1; month <= 12; month += 1) {
      const period = `${year}-${String(month).padStart(2, "0")}`;
      if (!missingMonths.includes(period)) presentMonths.push(period);
    }
  }
  const coverage = summarizePassengerMetricPeriods(presentMonths);
  assert.equal(coverage.distinctMonthCount, 78);
  assert.equal(coverage.missingMonthCount, 18);
  assert.deepEqual(coverage.missingMonths, missingMonths);
  assert.equal(coverage.rangeLabel, "78 months of data available within Jan 2018–Dec 2025.");
});

test("conflict QA table provides every raw batch/row reference and only public count values", () => {
  const conflicts = buildPassengerConflictReviewTable([
    {
      importBatchId: "batch-a",
      sourceRouteIdentifier: "Route 10",
      normalizedSourceRouteIdentifier: "route 10",
      month: "2025-01",
      passengerCount: 100,
      sourceFile: "first.csv",
      sourceRow: 4,
      mappingStatus: "CONFLICT",
    },
    {
      importBatchId: "batch-b",
      sourceRouteIdentifier: "Route 10",
      normalizedSourceRouteIdentifier: "route 10",
      month: "2025-01",
      passengerCount: 140,
      sourceFile: "second.csv",
      sourceRow: 8,
      mappingStatus: "CONFLICT",
    },
  ]);
  assert.deepEqual(conflicts, [{
    route: "Route 10",
    month: "2025-01",
    distinctPassengerCounts: [100, 140],
    rawRowReferences: [
      { importBatchId: "batch-a", sourceFile: "first.csv", sourceRow: 4 },
      { importBatchId: "batch-b", sourceFile: "second.csv", sourceRow: 8 },
    ],
  }]);
});

test("blank normalized routes are excluded from conflict QA groups", () => {
  assert.deepEqual(buildPassengerConflictReviewTable([
    {
      importBatchId: "batch-empty-a",
      sourceRouteIdentifier: "",
      normalizedSourceRouteIdentifier: "",
      month: "2023-02",
      passengerCount: 10,
      sourceFile: "blank-a.csv",
      sourceRow: 4,
      mappingStatus: "CONFLICT",
    },
    {
      importBatchId: "batch-empty-b",
      sourceRouteIdentifier: "",
      normalizedSourceRouteIdentifier: "",
      month: "2023-02",
      passengerCount: 20,
      sourceFile: "blank-b.csv",
      sourceRow: 8,
      mappingStatus: "CONFLICT",
    },
  ]), []);
});