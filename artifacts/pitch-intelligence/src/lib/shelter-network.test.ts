import assert from "node:assert/strict";
import { test } from "node:test";
import { activeKinds, activeShelters, clientProximity, distanceMeters, loadShelterPages, shelterInCampaignGeography, sheltersInCampaignGeography, shelterMapLayers } from "./shelter-network.ts";
import type { InventoryAsset, ProjectLocation } from "@workspace/api-client-react";

const asset = (id: string, lat = 25.2, lng = 55.2, overrides: Partial<InventoryAsset> = {}): InventoryAsset => ({
  id, assetCode: id, sourceFamily: "BUS_SHELTER", isActive: true, sourceLifecycleStatus: "ACTIVE",
  latitude: lat, longitude: lng, locationUnavailable: false, syncReviewReasons: [], removedDetectedAt: null,
  mediaUnits: [{ id: `${id}-static`, parentInventoryAssetId: id, unitType: "TOP_PANEL", format: "STATIC", lifecycleStatus: "ACTIVE" }],
  ...overrides,
} as InventoryAsset);
const client = (status: ProjectLocation["reviewStatus"], lat = 25.2): ProjectLocation =>
  ({ id: status, role: "CLIENT", reviewStatus: status, latitude: lat, longitude: 55.2, campaignGeographyStatus: "IN_CAMPAIGN_GEOGRAPHY" } as ProjectLocation);

test("all pages must complete, and a later failed page never returns a partial network", async () => {
  const offsets: number[] = [];
  const result = await loadShelterPages(async offset => {
    offsets.push(offset);
    return { offset, limit: 200, total: 3, items: offset === 0 ? [asset("a"), asset("b")] : [asset("c")] };
  });
  assert.deepEqual(offsets, [0, 2]);
  assert.deepEqual(result.map(a => a.id), ["a", "b", "c"]);
  await assert.rejects(loadShelterPages(async offset => {
    if (offset) throw new Error("Page two unavailable");
    return { offset, limit: 200, total: 2, items: [asset("a")] };
  }), /Page two unavailable/);
  await assert.rejects(loadShelterPages(async offset => ({ offset, limit: 200, total: 2, items: offset === 0 ? [asset("a")] : [] })), /empty before all/);
});
test("catalogue pagination loads beyond 200 and a failing third page rejects the entire load", async () => {
  const offsets: number[] = [];
  const result = await loadShelterPages(async offset => {
    offsets.push(offset);
    const count = Math.min(200, 423 - offset);
    return { offset, limit: 200, total: 423, items: Array.from({ length: count }, (_, i) => asset(`s-${offset + i}`)) };
  });
  assert.deepEqual(offsets, [0, 200, 400]);
  assert.equal(result.length, 423);
  assert.equal(result[422].id, "s-422");
  await assert.rejects(loadShelterPages(async offset => {
    if (offset === 400) throw new Error("Third page failed");
    return { offset, limit: 200, total: 423, items: Array.from({ length: 200 }, (_, i) => asset(`s-${offset + i}`)) };
  }), /Third page failed/);
});
test("removed, review-needed, inactive and inactive-unit shelters are absent", () => {
  const network = activeShelters([
    asset("valid"), asset("valid"),
    asset("removed", 25.2, 55.2, { sourceLifecycleStatus: "REMOVED" }),
    asset("inactive", 25.2, 55.2, { isActive: false }),
    asset("review", 25.2, 55.2, { syncReviewReasons: ["conflict"] }),
    asset("unavailable", 25.2, 55.2, { locationUnavailable: true }),
    asset("unit-off", 25.2, 55.2, { mediaUnits: [{ id: "off", parentInventoryAssetId: "unit-off", unitType: "TOP_PANEL", format: "DIGITAL", lifecycleStatus: "REMOVED" } as InventoryAsset["mediaUnits"][number]] }),
  ]);
  assert.deepEqual(network.map(a => a.id), ["valid"]);
  assert.deepEqual(activeKinds(asset("multi", 25.2, 55.2, { mediaUnits: [
    { id: "1", unitType: "TOP_PANEL", format: "STATIC", lifecycleStatus: "ACTIVE" },
    { id: "2", unitType: "MUPI", format: "DIGITAL", lifecycleStatus: "ACTIVE" },
  ] as InventoryAsset["mediaUnits"] })), ["shelters", "digitalMupis"]);
});
test("straight-line four bands count unique shelters, not units or duplicate stores", () => {
  const kmLat = 1 / 111195;
  const shelters = [asset("s1", 25.2 + 180 * kmLat), asset("s2", 25.2 + 400 * kmLat), asset("s3", 25.2 + 750 * kmLat), asset("s4", 25.2 + 950 * kmLat)];
  const metrics = clientProximity(client("APPROVED"), shelters)!;
  assert.deepEqual(metrics.counts, { 200: 1, 500: 2, 800: 3, 1000: 4 });
  assert.equal(metrics.nearest?.shelter.id, "s1");
  assert.ok(Math.abs(distanceMeters(25.2, 55.2, 25.2 + 180 * kmLat, 55.2) - 180) < 1);
});
test("candidate preview is gated from approved final coverage", () => {
  const shelters = [asset("s1")];
  assert.equal(clientProximity(client("NEEDS_REVIEW"), shelters)?.preview, true);
  assert.equal(clientProximity(client("APPROVED"), shelters)?.preview, false);
  assert.equal(clientProximity(client("REJECTED"), shelters), null);
  const outOfScope = { ...client("NEEDS_REVIEW", 24.49), campaignGeographyStatus: "OUTSIDE_CAMPAIGN_GEOGRAPHY" } as ProjectLocation;
  assert.equal(clientProximity(outOfScope, shelters), null);
  assert.equal(clientProximity({ ...outOfScope, reviewStatus: "APPROVED" }, shelters), null);
  assert.equal(clientProximity({ ...client("APPROVED"), campaignGeographyStatus: "UNVERIFIED_CAMPAIGN_GEOGRAPHY" } as ProjectLocation, shelters), null);
});
test("campaign geography narrows proximity inventory without changing Dubai map inventory", () => {
  const assets = [
    asset("city-walk", 25.2, 55.2, { area: "City Walk" }),
    asset("marina", 25.2, 55.2, { area: "Dubai Marina" }),
  ];
  assert.equal(shelterInCampaignGeography(assets[0], "DUBAI"), true);
  assert.equal(shelterInCampaignGeography(assets[1], "UAE"), true);
  assert.deepEqual(sheltersInCampaignGeography(assets, "ABU_DHABI"), []);
  assert.deepEqual(sheltersInCampaignGeography(assets, "CUSTOM", ["City Walk"]), [assets[0]]);
  assert.equal(shelterInCampaignGeography(asset("walkway", 25.2, 55.2, { area: "City Walkway" }), "CUSTOM", ["City Walk"]), false);
});
test("format and planning layers are independent; multiple formats remain one shelter", () => {
  const multi = asset("multi", 25.2, 55.2, { mediaUnits: [
    { id: "one", unitType: "TOP_PANEL", format: "STATIC", lifecycleStatus: "ACTIVE" },
    { id: "two", unitType: "MUPI", format: "DIGITAL", lifecycleStatus: "ACTIVE" },
  ] as InventoryAsset["mediaUnits"] });
  assert.deepEqual(shelterMapLayers(multi, new Set(["shelters", "digitalMupis"]), [])?.formats, ["shelters", "digitalMupis"]);
  assert.deepEqual(shelterMapLayers(multi, new Set(["selected"]), ["selected"]), { formats: [], overlays: ["selected"] });
  assert.deepEqual(shelterMapLayers(multi, new Set(["shortlisted"]), ["shortlisted"]), { formats: [], overlays: ["shortlisted"] });
  assert.equal(shelterMapLayers(multi, new Set(["digitalShelters"]), ["selected"]), null);
  assert.equal(activeShelters([multi]).length, 1);
});
test("removed assets never return via selected or shortlisted overlays", () => {
  for (const removed of [
    asset("removed", 25.2, 55.2, { sourceLifecycleStatus: "REMOVED" }),
    asset("marked", 25.2, 55.2, { removedDetectedAt: "2026-01-01" }),
    asset("off", 25.2, 55.2, { mediaUnits: [{ id: "old", unitType: "TOP_PANEL", format: "STATIC", lifecycleStatus: "REMOVED" }] as InventoryAsset["mediaUnits"] }),
  ]) {
    assert.equal(shelterMapLayers(removed, new Set(["selected", "shortlisted", "shelters"]), ["selected", "shortlisted"]), null);
  }
});