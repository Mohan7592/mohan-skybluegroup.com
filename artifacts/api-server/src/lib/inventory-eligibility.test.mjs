import assert from "node:assert/strict";
import test from "node:test";
import {
  INACTIVE_INVENTORY_LABEL,
  evaluateInventoryEligibility,
  isCurrentInventorySelection,
} from "./inventory-eligibility.ts";
import { partitionShelterSelections } from "./project-media-plan.ts";

const activeAsset = { isActive: true, sourceLifecycleStatus: "ACTIVE" };

test("active shelter with an active unit is current inventory", () => {
  assert.deepEqual(evaluateInventoryEligibility(activeAsset, { lifecycleStatus: "ACTIVE" }, true), {
    inventoryStatus: "CURRENT", inventoryStatusLabel: null, inventoryStatusReason: null,
  });
  assert.equal(isCurrentInventorySelection(activeAsset, null), true);
});

test("removed, deactivated or missing-from-source shelters are never current", () => {
  for (const asset of [
    { isActive: false, sourceLifecycleStatus: "REMOVED" },
    { isActive: true, sourceLifecycleStatus: "REMOVED" },
    { isActive: true, sourceLifecycleStatus: "MISSING_FROM_SOURCE" },
    { isActive: false, sourceLifecycleStatus: "ACTIVE" },
  ]) {
    const result = evaluateInventoryEligibility(asset, null);
    assert.equal(result.inventoryStatus, "INACTIVE_REMOVED", JSON.stringify(asset));
    assert.equal(result.inventoryStatusLabel, INACTIVE_INVENTORY_LABEL);
    assert.ok(result.inventoryStatusReason);
  }
});

test("a removed media unit (e.g. MUPI removed) is not current even on an active shelter", () => {
  const result = evaluateInventoryEligibility(activeAsset, { lifecycleStatus: "REMOVED" }, true);
  assert.equal(result.inventoryStatus, "INACTIVE_REMOVED");
  assert.equal(result.inventoryStatusLabel, "Inactive / Removed from current inventory");
});

test("a unit-level selection whose unit no longer resolves is not current", () => {
  assert.equal(evaluateInventoryEligibility(activeAsset, null, true).inventoryStatus, "INACTIVE_REMOVED");
  assert.equal(evaluateInventoryEligibility(activeAsset, undefined, true).inventoryStatus, "INACTIVE_REMOVED");
});

test("media plan keeps historical inactive selections separate and out of proposed totals", () => {
  const rows = [
    { id: "a", status: "selected", inventoryMediaUnitId: "u1", mediaUnitType: "TOP_PANEL", inventoryStatus: "CURRENT" },
    { id: "b", status: "shortlist", inventoryMediaUnitId: "u2", mediaUnitType: "MUPI", inventoryStatus: "INACTIVE_REMOVED" },
    { id: "c", status: "selected", inventoryMediaUnitId: null, mediaUnitType: null, inventoryStatus: "INACTIVE_REMOVED" },
    { id: "d", status: "rejected", inventoryMediaUnitId: "u3", mediaUnitType: "MUPI", inventoryStatus: "INACTIVE_REMOVED" },
  ];
  const result = partitionShelterSelections(rows);
  assert.deepEqual(result.proposedShelterSelections.map(({ id }) => id), ["a"]);
  assert.deepEqual(result.inactiveShelterSelections.map(({ id }) => id), ["b", "c"]);
  assert.deepEqual(result.rejectedShelterSelections.map(({ id }) => id), ["d"]);
  // Nothing is dropped: every historical row is still reported somewhere.
  assert.equal(
    result.proposedShelterSelections.length + result.inactiveShelterSelections.length + result.rejectedShelterSelections.length,
    rows.length,
  );
});
