import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeRouteId,
  parseRouteSheetValues,
  quoteSheetNameForA1,
  sheetNameFromA1Range,
} from "./bus-routes-google-sheets.ts";
import {
  isSameBusRouteSourceRow,
  planBusRouteSourceRows,
  reconcileBusRouteSourceIdentities,
  validateBusRouteSourceShrinkage,
} from "./bus-route-sync-plan.ts";

test("route parser keeps duplicate IDs as separate source-row variants", () => {
  const first = parseRouteSheetValues("Bus Routes Master ", [
    ["Route ID", "Starting Station", "Ending station", "Depot Name"],
    [" R-10 ", "Station A", "Station B", "Depot 1"],
    ["R-10", "Station C", "Station D", "Depot 2"],
  ]);
  const second = parseRouteSheetValues("Sheet5", [
    ["Route ID", "Via"],
    ["R-10", "Market"],
    ["R-11", "Airport"],
  ]);
  const rows = [...first.rows, ...second.rows];
  assert.equal(first.discovery.dataRows, 2);
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map(({ sheetName, sourceRowNumber }) => [sheetName, sourceRowNumber]), [
    ["Bus Routes Master ", 2],
    ["Bus Routes Master ", 3],
    ["Sheet5", 2],
    ["Sheet5", 3],
  ]);
  assert.equal(planBusRouteSourceRows(rows).distinctRoutes, 2);
});

test("repeated route variants remain separate by stable content identity", () => {
  const parsed = parseRouteSheetValues("routes", [
    ["Route ID"],
    ["R-1"],
    ["R-1"],
  ]).rows;
  assert.equal(planBusRouteSourceRows(parsed).distinctRoutes, 1);
  assert.notEqual(parsed[0].sourceIdentity, parsed[1].sourceIdentity);
  assert.throws(() => planBusRouteSourceRows([parsed[0], parsed[0]]), /Duplicate content source identity/);
});

test("identical source snapshots are idempotent and normalized route IDs are stable", () => {
  const incoming = parseRouteSheetValues("routes", [
    ["Route ID", "Via"],
    ["  R-12  ", "Main Street"],
  ]).rows[0];
  const firstPlan = planBusRouteSourceRows([incoming]);
  const secondPlan = planBusRouteSourceRows(parseRouteSheetValues("routes", [
    ["Route ID", "Via"],
    ["  R-12  ", "Main Street"],
  ]).rows);
  assert.equal(firstPlan.distinctRoutes, secondPlan.distinctRoutes);
  assert.equal([...firstPlan.rowIdentities][0], [...secondPlan.rowIdentities][0]);
  assert.equal(normalizeRouteId(incoming.routeId), incoming.normalizedRouteId);
  assert.equal(isSameBusRouteSourceRow({
    busRouteId: "stable-route-uuid",
    isActive: true,
    rawData: { Via: incoming.rawData.Via, "Route ID": incoming.rawData["Route ID"] },
  }, incoming, "stable-route-uuid"), true);
  assert.equal(isSameBusRouteSourceRow({
    busRouteId: "stable-route-uuid",
    isActive: true,
    rawData: { ...incoming.rawData, Via: "Changed" },
  }, incoming, "stable-route-uuid"), false);
});

test("vehicle-level tabs are reported but never parsed as route rows", () => {
  const parsed = parseRouteSheetValues("future buses", [
    ["Body Number", "Plate Number", "Route ID"],
    ["BUS-100", "ABC 123", "R-1"],
  ]);
  assert.equal(parsed.discovery.kind, "vehicle");
  assert.equal(parsed.discovery.dataRows, 1);
  assert.deepEqual(parsed.rows, []);
  for (const header of ["Body Number", "Bus Number", "Vehicle ID", "Fleet Number", "Plate Number", "pLaTe NuMbEr"]) {
    assert.equal(parseRouteSheetValues("vehicles", [[header], ["value"]]).discovery.kind, "vehicle");
  }
});

test("Route Number is accepted and partial/nonempty rows fail closed", () => {
  const parsed = parseRouteSheetValues("number route", [["Route Number", "Buses per Route"], ["X-1", "299"]]);
  assert.equal(parsed.rows[0].routeId, "X-1");
  assert.equal(parsed.rows[0].allocatedBusCount, 299);
  assert.throws(() => parseRouteSheetValues("bad tab", [["Starting Station"], ["Station"]]), /Route ID or Route Number/);
  assert.throws(() => parseRouteSheetValues("partial", [["Route ID", "Via"], ["", "Via data"]]), /blank Route ID/);
  assert.throws(() => parseRouteSheetValues("empty", [["Route Number"]]), /no valid data rows/);
  assert.throws(() => parseRouteSheetValues("empty", [["Route Number"], ["", ""]]), /no valid data rows/);
});

test("allocated bus count keeps raw cells, accepts blanks and rejects invalid nonblank values", () => {
  const parsed = parseRouteSheetValues("counts", [
    ["Route ID", "Buses per Route"],
    ["A", 299],
    ["B", ""],
  ]);
  assert.equal(parsed.rows[0].allocatedBusCount, 299);
  assert.equal(parsed.rows[0].rawData["Buses per Route"], 299);
  assert.equal(parsed.rows[1].allocatedBusCount, null);
  for (const badCount of [-1, "2.5", "not a number"]) {
    assert.throws(() => parseRouteSheetValues("counts", [
      ["Route ID", "Buses per Route"],
      ["A", badCount],
    ]), /invalid Buses per Route/);
  }
});

test("structural identity is stable across row reordering and structural edits", () => {
  const original = parseRouteSheetValues("routes", [
    ["Route ID", "Via"],
    ["A", "First"],
    ["B", "Second"],
    ["A", "First"],
  ]).rows;
  const reordered = parseRouteSheetValues("routes", [
    ["Route ID", "Via"],
    ["B", "Second"],
    ["A", "First"],
    ["A", "First"],
  ]).rows;
  assert.deepEqual(original.map((row) => row.sourceIdentity).sort(), reordered.map((row) => row.sourceIdentity).sort());
  const oldA = original.find((row) => row.rawData.Via === "First");
  const movedA = reordered.find((row) => row.rawData.Via === "First");
  assert.equal(oldA.sourceIdentity, movedA.sourceIdentity);
  assert.notEqual(oldA.sourceRowNumber, movedA.sourceRowNumber);
  assert.equal(isSameBusRouteSourceRow({
    busRouteId: "route-A",
    isActive: true,
    rawData: oldA.rawData,
  }, movedA, "route-A"), true);

  const edited = parseRouteSheetValues("routes", [
    ["Route ID", "Via"],
    ["A", "Edited"],
  ]).rows[0];
  assert.notEqual(oldA.sourceIdentity, edited.sourceIdentity);
  assert.equal(isSameBusRouteSourceRow({
    busRouteId: "route-A",
    isActive: true,
    rawData: oldA.rawData,
  }, edited, "route-A"), false);
});

test("count, campaign, and remarks edits retain a source variant identity", () => {
  const original = parseRouteSheetValues("routes", [
    ["Route ID", "Starting Station", "Ending station", "Via", "Depot Name", "Buses per Route", "Campaign", "Remarks"],
    ["A", "North", "South", "Market", "Central", 7, "Spring", "First note"],
  ]).rows[0];
  const edited = parseRouteSheetValues("routes", [
    ["Route ID", "Starting Station", "Ending station", "Via", "Depot Name", "Buses per Route", "Campaign", "Remarks"],
    ["A", "North", "South", "Market", "Central", 9, "Summer", "Updated note"],
  ]).rows[0];
  assert.equal(original.sourceIdentity, edited.sourceIdentity);
  assert.equal(original.structuralIdentity, edited.structuralIdentity);
  assert.equal(edited.allocatedBusCount, 9);
  reconcileBusRouteSourceIdentities([edited], [{
    sheetName: original.sheetName,
    sourceIdentity: "legacy-content-hash",
    rawData: original.rawData,
  }]);
  assert.equal(edited.sourceIdentity, "legacy-content-hash");
});

test("ambiguous structural duplicates match by full content or quarantine", () => {
  const original = parseRouteSheetValues("routes", [
    ["Route ID", "Starting Station", "Ending station", "Via", "Depot Name", "Buses per Route"],
    ["A", "North", "South", "Market", "Central", 7],
    ["A", "North", "South", "Market", "Central", 5],
  ]).rows;
  const oneCountChanged = parseRouteSheetValues("routes", [
    ["Route ID", "Starting Station", "Ending station", "Via", "Depot Name", "Buses per Route"],
    ["A", "North", "South", "Market", "Central", 6],
    ["A", "North", "South", "Market", "Central", 7],
  ]).rows;
  const previous = original.map((row, index) => ({
    sheetName: row.sheetName,
    sourceIdentity: `variant-${index}`,
    rawData: row.rawData,
  }));
  reconcileBusRouteSourceIdentities(oneCountChanged, previous);
  assert.equal(oneCountChanged.find((row) => row.allocatedBusCount === 7).sourceIdentity, "variant-0");
  assert.equal(oneCountChanged.find((row) => row.allocatedBusCount === 6).sourceIdentity, "variant-1");

  const bothChanged = parseRouteSheetValues("routes", [
    ["Route ID", "Starting Station", "Ending station", "Via", "Depot Name", "Buses per Route"],
    ["A", "North", "South", "Market", "Central", 8],
    ["A", "North", "South", "Market", "Central", 4],
  ]).rows;
  assert.throws(
    () => reconcileBusRouteSourceIdentities(bothChanged, previous),
    /Ambiguous duplicate bus-route variants/,
  );
});

test("large total or per-tab source shrinkage is blocked for manual review", () => {
  const old = { sourceRows: 100, discoveredSheets: [{ name: "routes", kind: "route", dataRows: 80 }] };
  assert.throws(() => validateBusRouteSourceShrinkage({
    sourceRows: 49,
    discoveredSheets: [{ name: "routes", kind: "route", dataRows: 80 }],
  }, old), /source row count.*shrink/);
  assert.throws(() => validateBusRouteSourceShrinkage({
    sourceRows: 80,
    discoveredSheets: [{ name: "routes", kind: "route", dataRows: 39 }],
  }, old), /routes.*shrink/);
  assert.doesNotThrow(() => validateBusRouteSourceShrinkage({
    sourceRows: 50,
    discoveredSheets: [{ name: "routes", kind: "route", dataRows: 40 }],
  }, old));
});

test("A1 ranges escape apostrophes and returned tab titles are preserved", () => {
  assert.equal(quoteSheetNameForA1("A tab's name"), "'A tab''s name'");
  assert.equal(sheetNameFromA1Range("'A tab''s name'!A1:ZZ"), "A tab's name");
  assert.equal(sheetNameFromA1Range("'Bus Routes Master '!A1:ZZ"), "Bus Routes Master ");
});