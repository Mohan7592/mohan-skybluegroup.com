import assert from "node:assert/strict";
import test from "node:test";
import { recommendNetworkRoutes } from "./network-recommendations.ts";
import { analyzePassengerRouteFamilies } from "./passenger-metrics-analysis.ts";

const routes = [
  {
    sourceVariantId: "variant-b",
    routeId: "B-2",
    from: "Deira",
    to: "Jumeirah",
    via: "Sheikh Zayed Road",
    depot: "Central",
    sourceSheet: "Master",
    sourceRow: 3,
    sourceBusCount: 2,
    isActive: true,
  },
  {
    sourceVariantId: "variant-a",
    routeId: "A-1",
    from: "Dubai Marina",
    to: "Downtown",
    via: "Sheikh Zayed Road",
    depot: "South",
    sourceSheet: "Master",
    sourceRow: 2,
    sourceBusCount: 80,
    isActive: true,
  },
  {
    sourceVariantId: "inactive",
    routeId: "A-0",
    from: "Downtown",
    to: "Downtown",
    via: null,
    depot: null,
    sourceSheet: "Master",
    sourceRow: 4,
    sourceBusCount: 15,
    isActive: false,
  },
  {
    sourceVariantId: "rejected",
    routeId: "A-2",
    from: "Downtown",
    to: "Dubai Marina",
    via: null,
    depot: "South",
    sourceSheet: "Master",
    sourceRow: 5,
    sourceBusCount: 15,
    isActive: true,
    isRejected: true,
  },
];

const base = {
  geography: "Dubai",
  targetBuses: 50,
  targetAreas: ["Downtown", "Dubai Marina"],
  targetRoads: ["Sheikh Zayed Road"],
  strategyApproved: true,
  routes,
};

test("allocates requested target deterministically across active strategy-matching routes", () => {
  const first = recommendNetworkRoutes(base);
  const second = recommendNetworkRoutes(base);
  assert.deepEqual(first, second);
  assert.deepEqual(first.recommendations.map(({ sourceVariantId }) => sourceVariantId), ["variant-a", "variant-b"]);
  assert.deepEqual(first.recommendations.map(({ proposedQuantity }) => proposedQuantity), [25, 25]);
  assert.equal(first.proposedTotal, 50);
  assert.equal(first.shortfall, 0);
  assert.equal(first.recommendations.some(({ sourceVariantId }) => sourceVariantId === "inactive"), false);
  assert.equal(first.recommendations.some(({ sourceVariantId }) => sourceVariantId === "rejected"), false);
  assert.equal(first.geography, "Dubai");
  assert.equal(first.geographyScope, "project context only; route operating geography unverified");
  assert.match(first.recommendations[0].rationale, /suggestive only/i);
  assert.match(first.recommendations[0].rationale, /does not confirm route operating geography/i);
  assert.ok(first.limitations.some((limitation) => /operating geography remains unverified pending source confirmation/i.test(limitation)));
});

test("source route counts remain context and never cap planning quantities", () => {
  const result = recommendNetworkRoutes({ ...base, targetBuses: 50 });
  assert.equal(result.recommendations[0].sourceBusCount, 80);
  assert.ok(result.recommendations[0].proposedQuantity > result.recommendations[1].sourceBusCount);
  assert.match(result.recommendations[0].quantityBasis, /not.*availability/i);
  assert.ok(result.limitations.some((limitation) => /not confirmed availability/i.test(limitation)));
});

test("returns explicit shortfall and null RTA evidence when no strategy targets match", () => {
  const result = recommendNetworkRoutes({
    ...base,
    targetAreas: ["Abu Dhabi"],
    targetRoads: [],
  });
  assert.equal(result.recommendations.length, 0);
  assert.equal(result.proposedTotal, 0);
  assert.equal(result.shortfall, 50);
  assert.equal(result.routeLevelEvidence.provider, "RTA passenger data");
  assert.equal(result.routeLevelEvidence.status, "unavailable");
  assert.equal(result.routeLevelEvidence.passengers, null);
  assert.equal(result.routeLevelEvidence.impressions, null);
  assert.equal(result.routeLevelEvidence.reach, null);
  assert.ok(result.limitations.some((limitation) => /No active Bus Routes Master/.test(limitation)));
});

test("geography and approved strategy are required for recommendations", () => {
  const noGeography = recommendNetworkRoutes({ ...base, geography: null });
  assert.equal(noGeography.recommendations.length, 0);
  assert.equal(noGeography.shortfall, 50);
  assert.ok(noGeography.limitations.some((limitation) => /geography is not recorded/.test(limitation)));

  const draftStrategy = recommendNetworkRoutes({ ...base, strategyApproved: false });
  assert.equal(draftStrategy.recommendations.length, 0);
  assert.ok(draftStrategy.limitations.some((limitation) => /No approved location strategy/.test(limitation)));
});

test("rejects duplicate selection beyond target and permits a positive allocation on a single match", () => {
  const result = recommendNetworkRoutes({ ...base, targetBuses: 1 });
  assert.equal(result.proposedTotal, 1);
  assert.equal(result.recommendations.length, 1);
  assert.equal(result.recommendations[0].proposedQuantity, 1);
});

test("attaches only exact route-ID passenger evidence with source, period, and approved geography", () => {
  const result = recommendNetworkRoutes({
    ...base,
    routePassengerEvidence: [
      { routeId: "B-2", sourceVariantId: "variant-b", source: "RTA source document", period: "2025 Q1", passengerCount: 1234 },
      { routeId: "b-2", source: "Wrong-case route", period: "2025 Q1", passengerCount: 9999 },
      { routeId: "B-20", source: "Different route", period: "2025 Q1", passengerCount: 8888 },
    ],
  });
  const routeB = result.recommendations.find(({ routeId }) => routeId === "B-2");
  const routeA = result.recommendations.find(({ routeId }) => routeId === "A-1");
  assert.deepEqual(routeB.routePassengerEvidence, [{
    routeId: "B-2",
    sourceVariantId: "variant-b",
    source: "RTA source document",
    period: "2025 Q1",
    passengerCount: 1234,
    projectGeographyContext: "Dubai",
    evidenceType: "route-level passenger data",
  }]);
  assert.equal(routeA.routePassengerEvidence, undefined);
  assert.equal("reach" in routeB.routePassengerEvidence[0], false);
  assert.equal("impressions" in routeB.routePassengerEvidence[0], false);
  assert.equal(result.routeLevelEvidence.status, "available");
  assert.equal(result.routeLevelEvidence.reach, null);
  assert.equal(result.routeLevelEvidence.impressions, null);
  assert.deepEqual(result.passengerEvidenceCoverage, {
    supportedRecommendedVariants: 1,
    recommendedVariants: 2,
    label: "Passenger-supported recommended variants: 1 of 2",
  });
  assert.deepEqual(routeB.evidenceSources, [
    "PASSENGER_EVIDENCE",
    "GEOGRAPHY_FROM_TO_VIA",
    "SOURCE_BUS_COUNT",
  ]);
});

test("route-family passenger evidence is returned once and never copied or scored per variant", () => {
  const [summary] = analyzePassengerRouteFamilies([
    {
      routeId: "B-2",
      mappingStatus: "ROUTE_LEVEL_ONLY",
      period: "2025-01",
      passengerCount: 5000,
      tripCount: null,
      sourceFile: "routes.csv",
      sourceRow: 7,
      importedAt: "2025-02-01T00:00:00.000Z",
    },
    {
      routeId: "B-2",
      mappingStatus: "ROUTE_LEVEL_ONLY",
      period: "2025-02",
      passengerCount: 6000,
      tripCount: null,
      sourceFile: "other-routes.csv",
      sourceRow: 8,
      importedAt: "2025-03-01T00:00:00.000Z",
    },
  ]);
  const input = {
    ...base,
    routeFamilyPassengerEvidence: [{
      routeId: summary.routeId,
      summary,
    }],
  };
  const withFamilyEvidence = recommendNetworkRoutes(input);
  const withoutFamilyEvidence = recommendNetworkRoutes(base);
  const routeB = withFamilyEvidence.recommendations.find(({ routeId }) => routeId === "B-2");
  assert.equal(withFamilyEvidence.routeFamilyPassengerEvidence.length, 1);
  assert.equal(withFamilyEvidence.routeFamilyPassengerEvidence[0].summary.latest.passengerCount, 6000);
  assert.equal("sourceFile" in withFamilyEvidence.routeFamilyPassengerEvidence[0].summary.latest, false);
  assert.equal("sourceRow" in withFamilyEvidence.routeFamilyPassengerEvidence[0].summary.latest, false);
  assert.equal("sourceFile" in withFamilyEvidence.routeFamilyPassengerEvidence[0].summary.previous, false);
  assert.equal("sourceRow" in withFamilyEvidence.routeFamilyPassengerEvidence[0].summary.previous, false);
  assert.equal("importBatchId" in withFamilyEvidence.routeFamilyPassengerEvidence[0], false);
  assert.equal("sourceObjectPath" in withFamilyEvidence.routeFamilyPassengerEvidence[0], false);
  assert.equal(routeB.routeFamilyPassengerEvidence, "ROUTE_LEVEL_ONLY");
  assert.equal(routeB.routePassengerEvidence, undefined);
  assert.equal(routeB.routePassengerSummary, undefined);
  assert.deepEqual(routeB.evidenceSources, ["GEOGRAPHY_FROM_TO_VIA", "SOURCE_BUS_COUNT"]);
  assert.equal(withFamilyEvidence.passengerEvidenceCoverage.label, "Passenger-supported recommended variants: 0 of 2");
  assert.deepEqual(
    withFamilyEvidence.recommendations.map(({ sourceVariantId, proposedQuantity }) => [sourceVariantId, proposedQuantity]),
    withoutFamilyEvidence.recommendations.map(({ sourceVariantId, proposedQuantity }) => [sourceVariantId, proposedQuantity]),
  );
});

test("carries imports' source row, timestamp and optional trip count as ridership-only context", () => {
  const result = recommendNetworkRoutes({
    ...base,
    routePassengerEvidence: [{
      routeId: "B-2",
      sourceVariantId: "variant-b",
      source: "route-ridership.csv",
      period: "2025-04",
      passengerCount: 102_400,
      tripCount: 2_150,
      sourceRow: 17,
      importedAt: "2025-05-02T10:00:00.000Z",
    }],
  });
  const route = result.recommendations.find(({ routeId }) => routeId === "B-2");
  assert.deepEqual(route.routePassengerEvidence[0], {
    routeId: "B-2",
    sourceVariantId: "variant-b",
    source: "route-ridership.csv",
    period: "2025-04",
    passengerCount: 102_400,
    tripCount: 2_150,
    sourceRow: 17,
    importedAt: "2025-05-02T10:00:00.000Z",
    projectGeographyContext: "Dubai",
    evidenceType: "route-level passenger data",
  });
  assert.equal(result.routeLevelEvidence.status, "available");
  assert.equal(result.routeLevelEvidence.passengers, null);
  assert.equal(result.routeLevelEvidence.impressions, null);
  assert.equal(result.routeLevelEvidence.reach, null);
  assert.ok(result.limitations.some((limitation) => /not campaign impressions/i.test(limitation)));
});

test("ignores passenger evidence unless project geography and approved target strategy qualify the route", () => {
  const evidence = [{ routeId: "B-2", sourceVariantId: "variant-b", source: "RTA source document", period: "2025 Q1", passengerCount: 1234 }];
  const noGeography = recommendNetworkRoutes({ ...base, geography: null, routePassengerEvidence: evidence });
  const unapproved = recommendNetworkRoutes({ ...base, strategyApproved: false, routePassengerEvidence: evidence });
  assert.equal(noGeography.recommendations.length, 0);
  assert.equal(unapproved.recommendations.length, 0);
});

test("same route ID passenger data stays attached only to its identified source variant", () => {
  const secondVariant = {
    ...routes[0],
    sourceVariantId: "variant-b-other-direction",
    sourceRow: 11,
    sourceBusCount: 20,
  };
  const result = recommendNetworkRoutes({
    ...base,
    routes: [...routes, secondVariant],
    routePassengerEvidence: [{
      routeId: "B-2",
      sourceVariantId: "variant-b",
      source: "routes.csv",
      period: "2025-04",
      passengerCount: 1234,
      summary: {
        latest: { period: "2025-04", passengerCount: 1234, tripCount: 20, passengersPerTrip: 61.7, sourceFile: "routes.csv", sourceRow: 8 },
        previous: null,
        threeMonthAverage: 1234,
        threeMonthPeriods: 1,
        sixMonthAverage: 1234,
        sixMonthPeriods: 1,
        availableTotal: 1234,
        availablePeriods: 1,
        duplicatePeriods: 0,
        conflictingPeriods: 0,
        passengerPercentile: 85,
        activity: "REPORTED_PASSENGER_ACTIVITY",
      },
    }],
  });
  const routeBVariants = result.recommendations.filter(({ routeId }) => routeId === "B-2");
  assert.equal(routeBVariants.length, 2);
  assert.equal(routeBVariants.find(({ sourceVariantId }) => sourceVariantId === "variant-b").routePassengerSummary.latest.passengerCount, 1234);
  assert.equal(routeBVariants.find(({ sourceVariantId }) => sourceVariantId === "variant-b-other-direction").routePassengerEvidence, undefined);
});

test("omits malformed optional passenger evidence", () => {
  const result = recommendNetworkRoutes({
    ...base,
    routePassengerEvidence: [
      { routeId: "B-2", sourceVariantId: "variant-b", source: " ", period: "2025 Q1", passengerCount: 1234 },
      { routeId: "B-2", sourceVariantId: "variant-b", source: "RTA source", period: "", passengerCount: 1234 },
      { routeId: "B-2", sourceVariantId: "variant-b", source: "RTA source", period: "2025 Q1", passengerCount: -1 },
      { routeId: "B-2", sourceVariantId: "variant-b", source: "RTA source", period: "2025 Q1", passengerCount: 1.5 },
    ],
  });
  assert.equal(result.recommendations.find(({ routeId }) => routeId === "B-2").routePassengerEvidence, undefined);
});

test("rejects generic targets and requires whole target phrases instead of substring matches", () => {
  const generic = recommendNetworkRoutes({
    ...base,
    targetAreas: [],
    targetRoads: ["Road", "Main Road"],
  });
  assert.equal(generic.recommendations.length, 0);
  assert.ok(generic.limitations.some((limitation) => /only generic terms/.test(limitation)));

  const substring = recommendNetworkRoutes({
    ...base,
    targetAreas: ["ket"],
    targetRoads: [],
    routes: [{
      ...routes[0],
      from: "Market District",
      to: "Retail Centre",
      via: null,
    }],
  });
  assert.equal(substring.recommendations.length, 0);
  assert.equal(substring.shortfall, 50);
});

test("network routes require positive evidence within campaign geography", () => {
  const dubaiRoute = {
    ...routes[0],
    from: "Downtown",
    to: "Dubai Marina",
    via: null,
  };
  const abuDhabiRoute = {
    ...routes[0],
    sourceVariantId: "abu-dhabi-route",
    from: "Reem Mall",
    to: "Yas Island",
    via: null,
  };
  const dubai = recommendNetworkRoutes({
    ...base,
    geography: "DUBAI",
    targetAreas: ["Downtown", "Dubai Marina"],
    targetRoads: [],
    routes: [dubaiRoute, abuDhabiRoute],
  });
  assert.deepEqual(dubai.recommendations.map(({ sourceVariantId }) => sourceVariantId), ["variant-b"]);
  assert.equal(dubai.recommendations.some(({ sourceVariantId }) => sourceVariantId === "abu-dhabi-route"), false);

  const abuDhabi = recommendNetworkRoutes({
    ...base,
    geography: "ABU_DHABI",
    targetAreas: ["Reem Mall", "Yas Island"],
    targetRoads: [],
    routes: [dubaiRoute, abuDhabiRoute],
  });
  assert.deepEqual(abuDhabi.recommendations.map(({ sourceVariantId }) => sourceVariantId), ["abu-dhabi-route"]);

  const custom = recommendNetworkRoutes({
    ...base,
    geography: "CUSTOM",
    campaignAreas: ["City Walk"],
    targetAreas: ["City Walk"],
    targetRoads: [],
    routes: [{ ...dubaiRoute, from: "City Walk", to: "City Walk" }],
  });
  assert.equal(custom.recommendations.length, 1);
  const customUnverified = recommendNetworkRoutes({
    ...base,
    geography: "CUSTOM",
    campaignAreas: ["City Walk"],
    targetAreas: ["Dubai Marina"],
    targetRoads: [],
    routes: [dubaiRoute],
  });
  assert.equal(customUnverified.recommendations.length, 0);
});