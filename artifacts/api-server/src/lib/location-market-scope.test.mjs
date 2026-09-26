import assert from "node:assert/strict";
import test from "node:test";
import {
  campaignGeographyStatus,
  filterLocationsToCampaignGeography,
  isShelterInCampaignGeography,
  routeHasCampaignGeographyEvidence,
} from "./location-market-scope.ts";

const reemMall = { id: "reem", name: "Reem Mall", area: "Abu Dhabi", address: null, role: "CLIENT" };
const dubaiHills = { id: "hills", name: "Dubai Hills Mall", area: "Dubai", address: null, role: "CLIENT" };

test("campaign geography status and location visibility use campaign geography, not project market", () => {
  assert.equal(campaignGeographyStatus(reemMall, "DUBAI"), "OUTSIDE_CAMPAIGN_GEOGRAPHY");
  assert.equal(campaignGeographyStatus(reemMall, "UAE"), "IN_CAMPAIGN_GEOGRAPHY");
  assert.equal(campaignGeographyStatus(dubaiHills, "DUBAI"), "IN_CAMPAIGN_GEOGRAPHY");
  assert.equal(campaignGeographyStatus({ name: "Unknown Store", area: null, address: null }, "DUBAI"),
    "UNVERIFIED_CAMPAIGN_GEOGRAPHY");
  assert.equal(campaignGeographyStatus(dubaiHills, null), "UNVERIFIED_CAMPAIGN_GEOGRAPHY");

  const locations = [reemMall, dubaiHills, { id: "unknown", name: "Unknown Store", area: null, address: null }];
  assert.deepEqual(
    filterLocationsToCampaignGeography(locations, "DUBAI").map(({ id }) => id),
    ["hills"],
  );
  assert.deepEqual(
    filterLocationsToCampaignGeography(locations, "UAE").map(({ id }) => id),
    ["reem", "hills"],
  );
  // Locations remain visible in responses; filtering only returns planning scope.
  assert.equal(locations.length, 3);
});

test("custom campaigns require explicit overlapping campaign area evidence", () => {
  assert.equal(campaignGeographyStatus(
    { name: "City Walk Mall", area: "City Walk", address: "Dubai" },
    "CUSTOM",
    ["City Walk"],
  ), "IN_CAMPAIGN_GEOGRAPHY");
  assert.equal(campaignGeographyStatus(dubaiHills, "CUSTOM", ["City Walk"]),
    "UNVERIFIED_CAMPAIGN_GEOGRAPHY");
  assert.deepEqual(
    filterLocationsToCampaignGeography([dubaiHills, {
      id: "city-walk", name: "City Walk Mall", area: "City Walk", address: null,
    }], "CUSTOM", ["City Walk"]).map(({ id }) => id),
    ["city-walk"],
  );
});

test("SkyBlue inventory is limited by campaign geography without changing general inventory", () => {
  const dubaiAsset = { area: "Dubai Marina", areaNormalized: "dubai marina", emirate: "Dubai" };
  assert.equal(isShelterInCampaignGeography(dubaiAsset, "DUBAI"), true);
  assert.equal(isShelterInCampaignGeography(dubaiAsset, "UAE"), true);
  assert.equal(isShelterInCampaignGeography(dubaiAsset, "ABU_DHABI"), false);
  assert.equal(isShelterInCampaignGeography(dubaiAsset, "CUSTOM", ["Dubai Marina"]), true);
  assert.equal(isShelterInCampaignGeography(dubaiAsset, "CUSTOM", ["Reem Island"]), false);
  assert.equal(isShelterInCampaignGeography(dubaiAsset, undefined), false);
});

test("routes require positive geography evidence or an approved target-area match", () => {
  assert.equal(routeHasCampaignGeographyEvidence("Dubai Marina to Downtown", "DUBAI"), true);
  assert.equal(routeHasCampaignGeographyEvidence("Downtown to Downtown", "DUBAI"), false);
  assert.equal(routeHasCampaignGeographyEvidence(
    "Downtown to Downtown", "DUBAI", [], ["Downtown"],
  ), true);
  assert.equal(routeHasCampaignGeographyEvidence(
    "Downtown Dubai to Abu Dhabi", "DUBAI", [], ["Downtown"],
  ), false);
  assert.equal(routeHasCampaignGeographyEvidence(
    "City Walk to City Walk", "CUSTOM", ["City Walk"], ["City Walk"],
  ), true);
  assert.equal(routeHasCampaignGeographyEvidence(
    "City Walk to City Walk", "CUSTOM", ["Dubai Marina"], ["City Walk"],
  ), false);
  assert.equal(routeHasCampaignGeographyEvidence("Downtown to Downtown", null, [], ["Downtown"]), false);
});