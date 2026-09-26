import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizePassengerMonth,
  passengerRouteMonthKey,
  parseCsvRecords,
  previewPassengerMetricsCsv,
  previewRtaPassengerJourneysCsv,
  reconcilePassengerRouteMonthConflicts,
  summarizePassengerMappingStatuses,
  summarizeSourcePeriodConflicts,
} from "./passenger-metrics-import.ts";

const routes = [
  { id: "r1", routeId: "F14", normalizedRouteId: "f14", sourceVariantId: "variant-r1" },
  { id: "r2", routeId: "F-14", normalizedRouteId: "f-14", sourceVariantId: "variant-r2" },
  { id: "r3", routeId: "X2", normalizedRouteId: "x2", sourceVariantId: "variant-r3" },
];
const mapping = { routeIdentifier: "Route", month: "Month", passengers: "Passengers", trips: "Trips" };

test("CSV parser handles quotes, commas, BOM, CRLF and data-row provenance", () => {
  const parsed = parseCsvRecords('\uFEFFRoute,Month,Passengers,Trips\r\nF14,"Jan, 2025","1,250",80\r\n');
  assert.deepEqual(parsed.headers, ["Route", "Month", "Passengers", "Trips"]);
  assert.equal(parsed.rows[0].values.Month, "Jan, 2025");
  assert.equal(parsed.rows[0].sourceRow, 2);
});

test("CSV parser rejects duplicate headers and malformed quoting", () => {
  assert.throws(() => parseCsvRecords("Route,Route\nF14,F14"), /duplicate column headers/i);
  assert.throws(() => parseCsvRecords('Route,Month\n"F14,2025-01'), /unterminated quoted/i);
  assert.throws(() => parseCsvRecords("Route,Month,Passengers\nF14,2025-01,500,private-value"), /more fields than its header/i);
});

test("month parsing preserves an unambiguous source calendar month", () => {
  assert.equal(normalizePassengerMonth("2025-1"), "2025-01");
  assert.equal(normalizePassengerMonth("1/2025"), "2025-01");
  assert.equal(normalizePassengerMonth("Sep 2024"), "2024-09");
  assert.equal(normalizePassengerMonth("2025-13"), null);
  assert.equal(normalizePassengerMonth("01/02/2025"), null);
});

test("only a unique exact normalized route identifier is automatically matched", () => {
  const preview = previewPassengerMetricsCsv(
    "Route,Month,Passengers,Trips\n F14 ,2025-01,1000,50\nF14,2025-02,1100,\n",
    mapping,
    "rta.csv",
    routes,
  );
  assert.equal(preview.summary.MATCHED_VARIANT, 2);
  assert.equal(preview.rows[0].busRouteId, "r1");
  assert.equal(preview.rows[0].sourceRow, 2);
  assert.equal(preview.rows[1].tripCount, null);
});

test("audit source values are preserved exactly while normalized fields are stored separately", () => {
  const preview = previewPassengerMetricsCsv(
    "Route,Month,Passengers,Trips\n F14 , 2025-01 ,00100,50\n",
    mapping,
    "rta.csv",
    routes,
  );
  assert.equal(preview.rows[0].sourceRouteIdentifier, "F14");
  assert.equal(preview.rows[0].month, "2025-01");
  assert.deepEqual(preview.rows[0].sourceValues, {
    Route: " F14 ",
    Month: " 2025-01 ",
    Passengers: "00100",
    Trips: "50",
  });
});

test("shared route IDs retain family-level evidence without attributing it to a variant", () => {
  const variants = [
    { id: "route-id", routeId: "R42", normalizedRouteId: "r42", sourceVariantId: "variant-a", sourceIdentity: "R42-A", sourceSheet: "Routes", sourceRow: 5 },
    { id: "route-id", routeId: "R42", normalizedRouteId: "r42", sourceVariantId: "variant-b", sourceIdentity: "R42-B", sourceSheet: "Routes", sourceRow: 6 },
  ];
  const withoutVariant = previewPassengerMetricsCsv(
    "Route,Month,Passengers,Trips\nR42,2025-01,1000,50\n",
    mapping,
    "routes.csv",
    variants,
  );
  assert.equal(withoutVariant.rows[0].mappingStatus, "ROUTE_LEVEL_ONLY");
  assert.equal(withoutVariant.rows[0].busRouteId, "route-id");
  assert.equal(withoutVariant.rows[0].sourceVariantId, null);
  assert.equal(withoutVariant.rows[0].routeCandidates.length, 2);

  const sharedSheetNotIdentity = previewPassengerMetricsCsv(
    "Route,Month,Passengers,Trips,Variant\nR42,2025-01,1000,50,Routes\n",
    { ...mapping, routeVariant: "Variant" },
    "routes.csv",
    variants,
  );
  assert.equal(sharedSheetNotIdentity.rows[0].mappingStatus, "ROUTE_LEVEL_ONLY");

  const withVariant = previewPassengerMetricsCsv(
    "Route,Month,Passengers,Trips,Variant\nR42,2025-01,1000,50,R42-B\n",
    { ...mapping, routeVariant: "Variant" },
    "routes.csv",
    variants,
  );
  assert.equal(withVariant.rows[0].mappingStatus, "MATCHED_VARIANT");
  assert.equal(withVariant.rows[0].sourceVariantId, "variant-b");
  assert.equal(withVariant.rows[0].sourceVariantIdentifier, "R42-B");
});

test("a compact identifier spanning route families remains unmatched", () => {
  const preview = previewPassengerMetricsCsv(
    "Route,Month,Passengers,Trips\nF14?,2025-01,1000,50\n",
    mapping,
    "rta.csv",
    routes,
  );
  assert.equal(preview.summary.UNMATCHED, 1);
  assert.equal(preview.rows[0].busRouteId, null);
  assert.deepEqual(preview.rows[0].routeCandidates.map((candidate) => candidate.id), ["r1", "r2"]);
});

test("a unique punctuation-only near match is not silently assigned to a route family", () => {
  const preview = previewPassengerMetricsCsv(
    "Route,Month,Passengers,Trips\nx-2,2025-01,1000,50\n",
    mapping,
    "rta.csv",
    routes,
  );
  assert.equal(preview.summary.UNMATCHED, 1);
  assert.equal(preview.rows[0].busRouteId, null);
  assert.equal(preview.rows[0].routeCandidates[0].id, "r3");
});

test("invalid count and month rows stay out of metric mapping", () => {
  const preview = previewPassengerMetricsCsv(
    "Route,Month,Passengers,Trips\nF14,2025-13,10,2\nF14,2025-01,-1,2\n",
    mapping,
    "rta.csv",
    routes,
  );
  assert.equal(preview.summary.INVALID, 2);
  assert.equal(preview.rows.every((row) => row.error && !row.busRouteId), true);
});

test("unrecognized columns and oversized imports fail explicitly", () => {
  assert.throws(() => previewPassengerMetricsCsv("A,B\nx,y", mapping, "rta.csv", routes), /not found/i);
  assert.throws(() => parseCsvRecords("x".repeat(20_000_001)), /20 MB/i);
});

test("access-event-shaped source headers are rejected before any data rows are parsed", () => {
  const accessEventFile = "Swipe ID,Event Date,Count\n\"unparsed synthetic row";
  assert.throws(
    () => previewPassengerMetricsCsv(accessEventFile, {
      routeIdentifier: "Swipe ID",
      month: "Event Date",
      passengers: "Count",
    }, "not-ridership.csv", routes),
    /personnel or access-event data/i,
  );
  assert.throws(
    () => previewPassengerMetricsCsv("User ID,Route,Month,Passenger Count\n\"unparsed synthetic row", {
      routeIdentifier: "Route",
      month: "Month",
      passengers: "Passenger Count",
    }, "not-ridership.csv", routes),
    /personnel or access-event data/i,
  );
});

test("RTA adapter requires explicit passenger-journey semantics and preserves raw fields", () => {
  const rtaRoutes = [
    { id: "route-66", routeId: "66", sourceVariantId: "variant-66" },
    { id: "route-e411", routeId: "E411", sourceVariantId: "variant-e411" },
    { id: "route-e411", routeId: "E411", sourceVariantId: "variant-e411-alt" },
  ];
  const csv = [
    "month,route_name,trips,year,load_timestamp",
    "Jun,66,10106,2023,2023-09-21T19:08:03.000Z",
    "Jul,E411,16358,2024,2024-09-21T19:08:03.000Z",
    "Jul,Unknown,0,2024,2024-09-21T19:08:03.000Z",
    "Jun,66,10106,2023,2023-09-22T19:08:03.000Z",
  ].join("\n");
  assert.throws(() => previewRtaPassengerJourneysCsv(csv, "rta.csv", rtaRoutes, { passengerJourneys: false }), /explicit --passenger-journeys flag/i);
  const preview = previewRtaPassengerJourneysCsv(csv, "rta.csv", rtaRoutes, { passengerJourneys: true });
  assert.deepEqual(preview.headers, ["month", "route_name", "trips", "year", "load_timestamp"]);
  assert.deepEqual(preview.summary, { MATCHED_VARIANT: 2, ROUTE_LEVEL_ONLY: 1, UNMATCHED: 1, CONFLICT: 0, INVALID: 0 });
  assert.equal(preview.rows[0]?.month, "2023-06");
  assert.equal(preview.rows[0]?.passengerCount, 10106);
  assert.equal(preview.rows[0]?.tripCount, null);
  assert.deepEqual(preview.rows[0]?.sourceValues, {
    month: "Jun", route_name: "66", trips: "10106", year: "2023", load_timestamp: "2023-09-21T19:08:03.000Z",
  });
  assert.equal(preview.rows[1]?.mappingStatus, "ROUTE_LEVEL_ONLY");
  assert.equal(preview.rows[1]?.sourceVariantId, null);
  assert.equal(preview.rows[2]?.mappingStatus, "UNMATCHED");
  const conflicts = summarizeSourcePeriodConflicts(preview.rows);
  assert.equal(conflicts.repeatedRouteMonths, 1);
  assert.equal(conflicts.conflictingRouteMonths, 0);
  const conflictingRows = summarizeSourcePeriodConflicts([
    ...preview.rows,
    { ...preview.rows[0], sourceRow: 6, passengerCount: 10107 },
  ]);
  assert.equal(conflictingRows.conflictingRouteMonths, 1);
});

test("divergent route-month source values override provisional matches with CONFLICT and clear attribution", () => {
  const variants = [
    { id: "family-10", routeId: "10", sourceVariantId: "10-a" },
    { id: "family-10", routeId: "10", sourceVariantId: "10-b" },
  ];
  const preview = previewPassengerMetricsCsv(
    "Route,Month,Passengers,Trips\n10,2025-01,100,4\n10,2025-01,130,5\n10,2025-02,90,4\n",
    mapping,
    "route-10.csv",
    variants,
  );
  assert.deepEqual(preview.rows.map((row) => row.mappingStatus), ["CONFLICT", "CONFLICT", "ROUTE_LEVEL_ONLY"]);
  assert.deepEqual(preview.rows.slice(0, 2).map((row) => [row.busRouteId, row.sourceVariantId]), [[null, null], [null, null]]);
  assert.equal(preview.summary.CONFLICT, 2);
  assert.equal(preview.summary.ROUTE_LEVEL_ONLY, 1);
  assert.deepEqual(summarizePassengerMappingStatuses(preview.rows), preview.summary);
  assert.equal(Object.values(preview.summary).reduce((total, count) => total + count, 0), preview.rows.length);
});

test("an import conflicts incoming rows against stored batches and keeps prior conflicts sticky", () => {
  const incoming = previewPassengerMetricsCsv(
    "Route,Month,Passengers,Trips\nF14,2025-03,120,5\n",
    mapping,
    "new-batch.csv",
    routes,
  ).rows;
  const storedBase = {
    normalizedSourceRouteIdentifier: "f14",
    month: "2025-03",
    passengerCount: 100,
    mappingStatus: "MATCHED_VARIANT",
    busRouteId: "r1",
    sourceVariantId: "variant-r1",
    matchedRouteId: "F14",
  };
  const reconciliation = reconcilePassengerRouteMonthConflicts(incoming, [storedBase]);
  assert.ok(reconciliation.conflictKeys.has(passengerRouteMonthKey(storedBase)));
  assert.equal(reconciliation.rows[0].mappingStatus, "CONFLICT");
  assert.deepEqual(
    [reconciliation.rows[0].busRouteId, reconciliation.rows[0].sourceVariantId],
    [null, null],
  );

  const sameCountIncoming = previewPassengerMetricsCsv(
    "Route,Month,Passengers,Trips\nF14,2025-03,100,5\n",
    mapping,
    "third-batch.csv",
    routes,
  ).rows;
  const stickyConflict = reconcilePassengerRouteMonthConflicts(sameCountIncoming, [{
    ...storedBase,
    mappingStatus: "CONFLICT",
    busRouteId: null,
    sourceVariantId: null,
    matchedRouteId: null,
  }]);
  assert.equal(stickyConflict.rows[0].mappingStatus, "CONFLICT");
  assert.equal(stickyConflict.rows[0].busRouteId, null);
});

test("RTA adapter retains invalid source rows in preview rather than silently dropping them", () => {
  const csv = "month,route_name,trips,year,load_timestamp\nFoo,66,nope,2024,load-a\n";
  const preview = previewRtaPassengerJourneysCsv(csv, "rta.csv", routes, { passengerJourneys: true });
  assert.equal(preview.rows.length, 1);
  assert.equal(preview.summary.INVALID, 1);
  assert.ok(preview.rows[0]?.error);
  assert.equal(preview.rows[0]?.sourceValues.trips, "nope");
  assert.equal(preview.rows[0]?.sourceValues.load_timestamp, "load-a");
});

test("RTA rows with a blank route name are preserved as unmatched without inventing an identifier", () => {
  const csv = "month,route_name,trips,year,load_timestamp\nMay,,52,2024,load-b\n";
  const preview = previewRtaPassengerJourneysCsv(csv, "rta.csv", routes, { passengerJourneys: true });
  assert.equal(preview.summary.INVALID, 0);
  assert.equal(preview.summary.UNMATCHED, 1);
  assert.equal(preview.rows[0]?.sourceRouteIdentifier, "");
  assert.equal(preview.rows[0]?.sourceValues.route_name, "");
  assert.equal(preview.rows[0]?.passengerCount, 52);
  assert.equal(preview.rows[0]?.busRouteId, null);
});

test("blank normalized routes never form passenger-month conflicts", () => {
  const preview = previewRtaPassengerJourneysCsv(
    "month,route_name,trips,year,load_timestamp\nFeb,,100,2023,load-a\nFeb,,200,2023,load-b\n",
    "blank-routes.csv",
    routes,
    { passengerJourneys: true },
  );
  assert.deepEqual(preview.rows.map((row) => row.mappingStatus), ["UNMATCHED", "UNMATCHED"]);
  assert.equal(preview.summary.CONFLICT, 0);
});