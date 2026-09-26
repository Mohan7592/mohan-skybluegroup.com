import assert from "node:assert/strict";
import test from "node:test";
import {
  coordinateSearchBounds,
  distanceMeters,
  mappedRawImportData,
  parseInventoryImportRow,
} from "./inventory.ts";

test("overlength asset IDs are rejected rather than truncated", () => {
  const assetCode = "A".repeat(161);
  const parsed = parseInventoryImportRow(
    { id: assetCode, kind: "Shelter" },
    { assetCode: "id", assetType: "kind" },
  );
  assert.equal(parsed.assetCode, assetCode);
  assert.ok(parsed.issues.includes("Asset ID exceeds 160 characters"));
});

test("manual bus import cannot identify vehicles by route number", () => {
  const route = parseInventoryImportRow(
    { "Route ID": "83", Kind: "Bus" },
    { assetCode: "Route ID", assetType: "Kind" },
  );
  assert.ok(route.issues.some((issue) => issue.includes("not a physical bus identifier")));
  const vehicle = parseInventoryImportRow(
    { "Body Number": "BUS-101", Kind: "Bus" },
    { assetCode: "Body Number", assetType: "Kind" },
  );
  assert.deepEqual(vehicle.issues, []);
});

test("raw import provenance retains only mapped approved columns", () => {
  const row = { "Asset ID": "A-1", "Location": "Karama", Secret: "drop me" };
  assert.deepEqual(mappedRawImportData(row, {
    assetCode: "Asset ID",
    area: "Location",
    ignoredField: "Secret",
  }), {
    "Asset ID": "A-1",
    Location: "Karama",
  });
});

test("near-pole bounds omit longitude so pole-adjacent points are not excluded", () => {
  const bounds = coordinateSearchBounds(89.99, 45, 2000);
  assert.equal(bounds.west, undefined);
  assert.equal(bounds.east, undefined);
  assert.equal(distanceMeters(89.99, 45, 89.999, -135) < 2000, true);
});

test("spherical bounds include the dateline crossing", () => {
  const bounds = coordinateSearchBounds(0, 179.999, 500);
  assert.ok(bounds.west !== undefined && bounds.west > 179);
  assert.ok(bounds.east !== undefined && bounds.east > 180);
  assert.ok(distanceMeters(0, 179.999, 0, -179.999) < 500);
});