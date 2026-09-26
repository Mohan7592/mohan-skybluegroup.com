import assert from "node:assert/strict";
import test from "node:test";
import {
  canRefreshDiscoveredProviderCandidate,
  calculateLocationScore,
  locationRecommendationEvidence,
  matchPoiCategoryPriority,
  shouldClearProjectPoiLink,
  shouldRecommendForLocation,
  validCoordinates,
  verifiedAudienceSeed,
} from "./location-intelligence-rules.ts";

test("location matching excludes invalid and incomplete coordinates", () => {
  assert.equal(validCoordinates(25.2, 55.3), true);
  assert.equal(validCoordinates(null, 55.3), false);
  assert.equal(validCoordinates(91, 55.3), false);
  assert.equal(validCoordinates(25.2, Number.NaN), false);
});

test("location score is deterministic and normalized only across known criteria", () => {
  const result = calculateLocationScore([
    { criterion: "POI proximity", points: 35, maximum: 40, explanation: "Approved POI evidence" },
    { criterion: "Target area", points: 20, maximum: 20, explanation: "Area matches" },
  ]);
  assert.equal(result.score, 92);
  assert.equal(result.components.length, 2);
  assert.equal(calculateLocationScore([]).score, 0);
});

test("target-area-only recommendation persists without dereferencing a missing POI distance", () => {
  assert.equal(shouldRecommendForLocation({
    hasNearbyPoi: false,
    matchesTargetArea: true,
    matchesTargetRoad: false,
  }), true);
  assert.deepEqual(locationRecommendationEvidence([
    { criterion: "Target area", points: 20, maximum: 20, explanation: "Approved area match" },
  ], null), {
    components: [
      { criterion: "Target area", points: 20, maximum: 20, explanation: "Approved area match" },
    ],
    distanceMeters: null,
  });
});

test("POI category priority uses specific category evidence and skips generic provider categories", () => {
  const strategy = [
    { name: "Supermarket or hypermarket", priority: 1 },
    { name: "Residential area", priority: 2 },
  ];
  assert.deepEqual(matchPoiCategoryPriority("supermarket", strategy), {
    category: "Supermarket or hypermarket",
    priority: 1,
  });
  assert.equal(matchPoiCategoryPriority("shop", strategy), null);
  assert.equal(matchPoiCategoryPriority("amenity", strategy), null);
});

test("initial audience seed requires approved non-demo source-backed evidence with a verified quote", () => {
  const claim = {
    claim: "The audience includes young families shopping for groceries.",
    category: "company.target_audience",
    status: "approved",
    isDemo: false,
    methodology: "Source-exact excerpt: “Young families are our primary customers in the grocery category.”",
    source: {
      title: "Company profile",
      url: "https://example.com/company",
      publisher: "Example Publisher",
      publishedAt: new Date("2025-01-01T00:00:00Z"),
      retrievedAt: new Date("2025-01-02T00:00:00Z"),
    },
  };
  const seeded = verifiedAudienceSeed(claim);
  assert.match(seeded, /young families/i);
  assert.match(seeded, /https:\/\/example\.com\/company/);
  assert.match(seeded, /verified quote:/);
  assert.equal(verifiedAudienceSeed({ ...claim, isDemo: true }), null);
  assert.equal(verifiedAudienceSeed({ ...claim, status: "draft" }), null);
  assert.equal(verifiedAudienceSeed({ ...claim, source: null }), null);
  assert.equal(verifiedAudienceSeed({ ...claim, methodology: null }), null);
  assert.equal(verifiedAudienceSeed({ ...claim, category: "company.key_markets" }), null);
  assert.match(verifiedAudienceSeed({ ...claim, methodology: null }, {
    decision: "approved",
    sourceQuote: "Young families are our primary customers in the grocery category.",
    quoteVerifiedAt: new Date("2025-01-03T00:00:00Z"),
  }), /verified quote:/);
  assert.equal(verifiedAudienceSeed({ ...claim, methodology: null }, {
    decision: "approved",
    sourceQuote: "Young families are our primary customers in the grocery category.",
    quoteVerifiedAt: null,
  }), null);
});

test("provider rediscovery refreshes only the matching role's pending candidate", () => {
  const existing = {
    role: "POI",
    provider: "openstreetmap-nominatim",
    providerId: "node:123",
    reviewStatus: "NEEDS_REVIEW",
  };
  const sameCandidate = {
    role: "POI",
    provider: "openstreetmap-nominatim",
    providerId: "node:123",
  };
  assert.equal(canRefreshDiscoveredProviderCandidate(existing, sameCandidate), true);
  assert.equal(canRefreshDiscoveredProviderCandidate({ ...existing, reviewStatus: "APPROVED" }, sameCandidate), false);
  assert.equal(canRefreshDiscoveredProviderCandidate({ ...existing, reviewStatus: "REJECTED" }, sameCandidate), false);
  assert.equal(canRefreshDiscoveredProviderCandidate(existing, { ...sameCandidate, role: "CLIENT" }), false);
  assert.equal(canRefreshDiscoveredProviderCandidate(existing, { ...sameCandidate, providerId: "node:456" }), false);
});

test("leaving approval clears only a project POI link", () => {
  assert.equal(shouldClearProjectPoiLink("POI", "NEEDS_REVIEW"), true);
  assert.equal(shouldClearProjectPoiLink("POI", "REJECTED"), true);
  assert.equal(shouldClearProjectPoiLink("POI", "APPROVED"), false);
  assert.equal(shouldClearProjectPoiLink("CLIENT", "REJECTED"), false);
});
