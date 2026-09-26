import assert from "node:assert/strict";
import test from "node:test";
import {
  campaignGeographyStatusFromEvidence,
  campaignScopedProposedBusTotal,
  isBusShelterSourceFamily,
  partitionShelterSelections,
} from "./project-media-plan.ts";
import {
  isShelterInCampaignGeography,
  routeHasCampaignGeographyEvidence,
} from "./location-market-scope.ts";
import {
  GetProjectMediaPlanResponse,
} from "../../../../lib/api-zod/src/generated/api.ts";

test("media plan excludes manual bus/other inventory and separates rejected shelter selections", () => {
  const rows = [
    {
      sourceFamily: "BUS_SHELTER",
      status: "selected",
      inventoryMediaUnitId: "unit-top",
      mediaUnitType: "TOP_PANEL",
    },
    {
      sourceFamily: "BUS_SHELTER",
      status: "rejected",
      inventoryMediaUnitId: "unit-mupi",
      mediaUnitType: "MUPI",
    },
    {
      sourceFamily: "BUS",
      status: "selected",
      inventoryMediaUnitId: null,
      mediaUnitType: null,
    },
    {
      sourceFamily: "MANUAL",
      status: "shortlist",
      inventoryMediaUnitId: null,
      mediaUnitType: null,
    },
  ];
  const shelters = rows.filter(({ sourceFamily }) => isBusShelterSourceFamily(sourceFamily));
  const partitioned = partitionShelterSelections(shelters);
  assert.deepEqual(partitioned.proposedShelterSelections.map(({ mediaUnitType }) => mediaUnitType), ["TOP_PANEL"]);
  assert.deepEqual(partitioned.rejectedShelterSelections.map(({ mediaUnitType }) => mediaUnitType), ["MUPI"]);
});

test("shelter campaign scope honors the Dubai network and explicit custom-area overlap", () => {
  const dubaiShelter = { area: "Jumeirah", areaNormalized: "jumeirah" };
  assert.equal(isShelterInCampaignGeography(dubaiShelter, "DUBAI"), true);
  assert.equal(isShelterInCampaignGeography(dubaiShelter, "UAE"), true);
  assert.equal(isShelterInCampaignGeography(dubaiShelter, "ABU_DHABI"), false);
  assert.equal(isShelterInCampaignGeography(dubaiShelter, "CUSTOM", ["Jumeirah"]), true);
  assert.equal(isShelterInCampaignGeography(dubaiShelter, "CUSTOM", ["Downtown"]), false);
  assert.equal(isShelterInCampaignGeography({ area: null }, "CUSTOM", ["Jumeirah"]), false);
  assert.equal(campaignGeographyStatusFromEvidence(
    isShelterInCampaignGeography(dubaiShelter, "DUBAI"),
    false,
  ), "IN_CAMPAIGN_GEOGRAPHY");
  assert.equal(campaignGeographyStatusFromEvidence(
    isShelterInCampaignGeography(dubaiShelter, "ABU_DHABI"),
    true,
  ), "OUTSIDE_CAMPAIGN_GEOGRAPHY");
  assert.equal(campaignGeographyStatusFromEvidence(
    isShelterInCampaignGeography(dubaiShelter, "CUSTOM", ["Downtown"]),
    false,
  ), "UNVERIFIED_CAMPAIGN_GEOGRAPHY");
  assert.equal(routeHasCampaignGeographyEvidence("Dubai Marina JLT", "DUBAI"), true);
  assert.equal(routeHasCampaignGeographyEvidence("Unknown route", "DUBAI"), false);
});

test("bus totals include only non-rejected routes with proven campaign overlap", () => {
  const selections = [
    { status: "PROPOSED", proposedQuantity: 5, campaignGeographyStatus: "IN_CAMPAIGN_GEOGRAPHY" },
    { status: "SHORTLISTED", proposedQuantity: 4, campaignGeographyStatus: "OUTSIDE_CAMPAIGN_GEOGRAPHY" },
    { status: "PROPOSED", proposedQuantity: 3, campaignGeographyStatus: "UNVERIFIED_CAMPAIGN_GEOGRAPHY" },
    { status: "REJECTED", proposedQuantity: 8, campaignGeographyStatus: "IN_CAMPAIGN_GEOGRAPHY" },
  ];
  assert.equal(campaignScopedProposedBusTotal(selections), 5);
});

test("media-plan contract parses geography annotations and shelter area evidence", () => {
  const projectId = "11111111-1111-4111-8111-111111111111";
  const date = "2026-01-01T00:00:00.000Z";
  const busSelection = {
    id: "22222222-2222-4222-8222-222222222222",
    projectId,
    sourceVariantId: "33333333-3333-4333-8333-333333333333",
    routeId: "R1",
    from: "Dubai Marina",
    to: "JLT",
    via: null,
    depot: null,
    sourceBusCount: null,
    sourceSheet: "Routes",
    sourceRow: 1,
    lastSeenAt: null,
    originalSourceData: {},
    isSourceActive: true,
    campaignGeographyStatus: "IN_CAMPAIGN_GEOGRAPHY",
    proposedQuantity: 2,
    requiresOverride: false,
    status: "PROPOSED",
    internalNote: null,
    overrideSourceCount: false,
    overrideReason: null,
    overrideAt: null,
    overrideCountSnapshot: null,
    createdAt: date,
    updatedAt: date,
  };
  const shelterSelection = {
    selectionId: "44444444-4444-4444-8444-444444444444",
    inventoryAssetId: "55555555-5555-4555-8555-555555555555",
    inventoryMediaUnitId: null,
    status: "selected",
    note: null,
    assetCode: "SH-1",
    assetType: "BUS_SHELTER",
    assetName: "Jumeirah shelter",
    area: "Jumeirah",
    campaignGeographyStatus: "IN_CAMPAIGN_GEOGRAPHY",
    mediaUnitType: null,
    mediaFormat: null,
    currentClient: null,
    availabilityStatus: null,
    campaignStart: null,
    campaignEnd: null,
  };
  const response = GetProjectMediaPlanResponse.parse({
    projectId,
    shelterSelections: [shelterSelection],
    rejectedShelterSelections: [],
    busPlan: { projectId, selections: [busSelection], totalProposedBuses: 2 },
    totalProposedBuses: 2,
  });
  assert.equal(response.busPlan.selections[0].campaignGeographyStatus, "IN_CAMPAIGN_GEOGRAPHY");
  assert.equal(response.shelterSelections[0].area, "Jumeirah");
});