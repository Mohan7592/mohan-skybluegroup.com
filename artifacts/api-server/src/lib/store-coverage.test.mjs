import assert from "node:assert/strict";
import test from "node:test";
import {
  buildStoreCoverage,
  isWithinStraightLineRadius,
  LOCATION_RADII,
} from "./location-intelligence-coverage.ts";

const metersToLongitude = (meters) => meters / 6_371_000 * (180 / Math.PI);

function location(id, longitude, overrides = {}) {
  return {
    id,
    projectId: "project-1",
    role: "CLIENT",
    reviewStatus: "APPROVED",
    name: `Store ${id}`,
    category: "Store",
    address: null,
    latitude: 0,
    longitude,
    ...overrides,
  };
}

function asset(id, longitude, overrides = {}) {
  return {
    id,
    assetCode: `S-${id}`,
    assetName: `Shelter ${id}`,
    assetType: "Bus Shelter",
    sourceFamily: "BUS_SHELTER",
    sourceLifecycleStatus: "ACTIVE",
    isActive: true,
    syncReviewReasons: [],
    latitude: 0,
    longitude,
    ...overrides,
  };
}

function unit(id, parentInventoryAssetId, unitType, format, lifecycleStatus = "ACTIVE") {
  return { id, parentInventoryAssetId, unitType, format, lifecycleStatus };
}

test("coverage uses inclusive radius boundaries and the supported bands", () => {
  assert.deepEqual(LOCATION_RADII, [200, 500, 800, 1000]);
  assert.equal(isWithinStraightLineRadius(200, 200), true);
  assert.equal(isWithinStraightLineRadius(200.001, 200), false);
  const atBoundary = buildStoreCoverage(
    [location("store", 0)],
    [asset("edge", metersToLongitude(199.999))],
    [unit("edge-top", "edge", "TOP_PANEL", "DIGITAL")],
  );
  assert.equal(atBoundary.locations[0].bands[200].shelterCount, 1);
});

test("overlapping stores count coverage per location but deduplicate aggregate shelters and units", () => {
  const result = buildStoreCoverage(
    [location("store-a", 0), location("store-b", metersToLongitude(100))],
    [
      asset("shared", metersToLongitude(50)),
      asset("outer", metersToLongitude(350)),
    ],
    [
      unit("shared-top", "shared", "TOP_PANEL", "DIGITAL"),
      unit("shared-mupi", "shared", "MUPI", "DIGITAL"),
      unit("shared-static", "shared", "TOP_PANEL", "STATIC"),
      unit("outer-static", "outer", "MUPI", "STATIC"),
    ],
  );
  assert.equal(result.locations.length, 2);
  assert.equal(result.locations[0].bands[200].shelterCount, 1);
  assert.equal(result.locations[1].bands[200].shelterCount, 1);
  assert.deepEqual(result.aggregate.bands[200], {
    locationsCoveredCount: 2,
    uniqueShelterCount: 1,
    mediaUnitCounts: { digitalTopPanels: 1, digitalMupis: 1, static: 1 },
  });
  assert.equal(result.aggregate.bands[500].uniqueShelterCount, 2);
  assert.deepEqual(result.aggregate.bands[500].mediaUnitCounts, {
    digitalTopPanels: 1,
    digitalMupis: 1,
    static: 2,
  });
  assert.equal(result.locations[0].nearbyShelters[0].distanceMeters, 50);
  assert.deepEqual(result.locations[0].bands[200].matchedShelterIds, ["shared"]);
});

test("only approved coordinate-backed client stores and active eligible shelters are included", () => {
  const result = buildStoreCoverage(
    [
      location("approved", 0),
      location("unapproved", 0, { reviewStatus: "NEEDS_REVIEW" }),
      location("competitor", 0, { role: "COMPETITOR" }),
      location("missing-coordinates", 0, { latitude: null }),
    ],
    [
      asset("eligible", metersToLongitude(10)),
      asset("inactive", metersToLongitude(10), { isActive: false }),
      asset("removed", metersToLongitude(10), { sourceLifecycleStatus: "REMOVED" }),
      asset("conflicted", metersToLongitude(10), { syncReviewReasons: ["source conflict"] }),
      asset("no-coordinates", 0, { latitude: null }),
    ],
    [
      unit("eligible-unit", "eligible", "TOP_PANEL", "DIGITAL"),
      unit("inactive-unit", "eligible", "MUPI", "DIGITAL", "REMOVED"),
      unit("inactive-parent-unit", "inactive", "TOP_PANEL", "DIGITAL"),
      unit("removed-parent-unit", "removed", "TOP_PANEL", "DIGITAL"),
      unit("conflicted-parent-unit", "conflicted", "TOP_PANEL", "DIGITAL"),
      unit("no-coordinate-parent-unit", "no-coordinates", "TOP_PANEL", "DIGITAL"),
    ],
  );
  assert.deepEqual(result.locations.map(({ id }) => id), ["approved"]);
  assert.equal(result.locations[0].bands[200].shelterCount, 1);
  assert.deepEqual(result.aggregate.bands[200].mediaUnitCounts, {
    digitalTopPanels: 1,
    digitalMupis: 0,
    static: 0,
  });
});

test("empty approved store set returns empty bands without invented reach", () => {
  const result = buildStoreCoverage(
    [location("needs-review", 0, { reviewStatus: "NEEDS_REVIEW" })],
    [asset("shelter", 0)],
    [unit("unit", "shelter", "TOP_PANEL", "DIGITAL")],
  );
  assert.deepEqual(result.locations, []);
  assert.deepEqual(result.aggregate.bands[1000], {
    locationsCoveredCount: 0,
    uniqueShelterCount: 0,
    mediaUnitCounts: { digitalTopPanels: 0, digitalMupis: 0, static: 0 },
  });
  assert.match(result.limitations.join(" "), /not audience reach/);
});