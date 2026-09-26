import assert from "node:assert/strict";
import test from "node:test";
import {
  brandConfirmationAction,
  canResolveResearchGaps,
  canRefreshProjectResearch,
  canRetryFailedBrandResolution,
  hasSourceBackedOfficialBrandEvidence,
  isEligibleQuickRunForDeepResearch,
  isWithinRecentResearchWindow,
  isPlausibleBrandSpelling,
  isSelfBrandCandidate,
  quoteExplicitlyLocatesInUae,
  lastAttemptTimestamp,
  officialBrandFromPageTitle,
  sourceBackedOfficialBrandEvidenceRejection,
} from "./research-orchestrator-rules.ts";

test("recent marketing evidence requires a dated source within the rolling six-month window", () => {
  const now = new Date("2025-08-15T12:00:00.000Z");
  assert.equal(isWithinRecentResearchWindow(new Date("2025-02-15T12:00:00.000Z"), now), true);
  assert.equal(isWithinRecentResearchWindow(new Date("2025-02-14T12:00:00.000Z"), now), false);
  assert.equal(isWithinRecentResearchWindow(new Date("2025-08-16T12:00:00.000Z"), now), true);
  assert.equal(isWithinRecentResearchWindow(new Date("2025-08-17T12:00:00.000Z"), now), false);
  assert.equal(isWithinRecentResearchWindow(null, now), false);
});

test("UAE relevance must be stated in cited text, not inferred from a search query", () => {
  assert.equal(quoteExplicitlyLocatesInUae("The activation launched in Dubai and Abu Dhabi."), true);
  assert.equal(quoteExplicitlyLocatesInUae("Available throughout the United Arab Emirates."), true);
  assert.equal(quoteExplicitlyLocatesInUae("The brand expanded across the Middle East."), false);
  assert.equal(quoteExplicitlyLocatesInUae("A global campaign launched this quarter."), false);
});

test("deep research only starts from a terminal confirmed quick run with deep stages still pending", () => {
  const stages = [
    "company_research", "recent_marketing", "campaign_research", "ooh_research", "current_promotion", "source_validation",
  ].map((key) => ({ key, status: "complete" }));
  stages.push(
    { key: "competitor_discovery", status: "pending" },
    { key: "competitor_research", status: "pending" },
    { key: "ai_synthesis", status: "pending" },
    { key: "strategy_generation", status: "pending" },
  );
  const input = { scope: "live_research_v1", status: "completed", confirmedBrand: { name: "Brand" }, stages };
  assert.equal(isEligibleQuickRunForDeepResearch(input), true);
  assert.equal(isEligibleQuickRunForDeepResearch({ ...input, status: "running" }), false);
  assert.equal(isEligibleQuickRunForDeepResearch({ ...input, scope: "live_research_pitch_v1" }), false);
  assert.equal(isEligibleQuickRunForDeepResearch({
    ...input, status: "partial_success",
    stages: stages.map((stage) => stage.key === "ooh_research" ? { ...stage, status: "limited_evidence" } : stage),
  }), true);
  assert.equal(isEligibleQuickRunForDeepResearch({ ...input, confirmedBrand: null }), false);
});

test("new projects need confirmed setup while projects with historical runs remain refreshable", () => {
  const complete = {
    hasHistoricalRuns: false,
    confirmedBrandName: "Brand",
    officialWebsite: "https://brand.example",
    market: "UAE",
    category: "Retail",
    productFocus: null,
    pitchObjective: "Launch awareness",
    preferredMedia: "OOH",
  };
  assert.equal(canRefreshProjectResearch(complete), true);
  assert.equal(canRefreshProjectResearch({ ...complete, confirmedBrandName: null }), false);
  assert.equal(canRefreshProjectResearch({ ...complete, preferredMedia: null }), false);
  assert.equal(canRefreshProjectResearch({ ...complete, hasHistoricalRuns: true, confirmedBrandName: null }), true);
});

test("typo matching allows close spellings while rejecting unrelated entities", () => {
  assert.equal(isPlausibleBrandSpelling("Hisence", "Hisense"), true);
  assert.equal(isPlausibleBrandSpelling("Hisence", "Samsung"), false);
  const officialEvidence = {
    enteredName: "Hisence",
    candidateName: "Hisense",
    host: "www.hisense.com",
    title: "About Hisense",
    sourceText: "Hisense is a global consumer electronics and home appliances company.",
    evidenceQuote: "Hisense is a global consumer electronics and home appliances company.",
  };
  assert.equal(hasSourceBackedOfficialBrandEvidence(officialEvidence), true);
  assert.equal(hasSourceBackedOfficialBrandEvidence({
    ...officialEvidence,
    host: "hisenseme.com",
  }), true);
  assert.equal(hasSourceBackedOfficialBrandEvidence({
    ...officialEvidence,
    host: "hisenseofficial.com",
  }), false);
  assert.equal(hasSourceBackedOfficialBrandEvidence({
    ...officialEvidence,
    candidateName: "Samsung",
    host: "www.samsung.com",
  }), false);
  assert.equal(sourceBackedOfficialBrandEvidenceRejection({
    ...officialEvidence,
    evidenceQuote: "An LLM-generated brand quote not present on the page.",
  }), "quote_not_exact_source_text");
});

test("a short brand name may suggest a source-backed official full name without accepting unrelated brands", () => {
  const evidence = {
    enteredName: "Max",
    candidateName: "Max Fashion",
    host: "www.maxfashion.com",
    title: "Max Fashion | About us",
    sourceText: "Max Fashion is a value fashion retailer in the Middle East.",
    evidenceQuote: "Max Fashion is a value fashion retailer in the Middle East.",
  };
  assert.equal(hasSourceBackedOfficialBrandEvidence(evidence), true);
  assert.equal(sourceBackedOfficialBrandEvidenceRejection({
    ...evidence,
    candidateName: "HBO Max",
    host: "www.hbomax.com",
  }), "name_similarity_too_low");
  assert.equal(sourceBackedOfficialBrandEvidenceRejection({
    ...evidence,
    candidateName: "Maximum",
    host: "www.maximum.com",
  }), "name_similarity_too_low");
  assert.equal(sourceBackedOfficialBrandEvidenceRejection({
    ...evidence,
    host: "maxgroup.ae",
  }), "official_domain_name_mismatch");
});

test("official about-page title recovers a full brand name only with exact text and matching domain", () => {
  const source = {
    enteredName: "Max",
    host: "www2.maxfashion.com",
    title: "About us · Max Fashion",
    sourceText: "About us · Max Fashion About Us The most trusted value fashion retailer in the Middle East.",
  };
  assert.deepEqual(officialBrandFromPageTitle(source), {
    name: "Max Fashion",
    evidenceQuote: source.title,
  });
  assert.equal(officialBrandFromPageTitle({ ...source, host: "unrelated.com" }), null);
  assert.equal(officialBrandFromPageTitle({ ...source, sourceText: "A different page" }), null);
  assert.equal(officialBrandFromPageTitle({
    ...source,
    title: "About HBO Max · HBO Max",
    sourceText: "About HBO Max · HBO Max",
    host: "hbomax.com",
  }), null);
});

test("brand confirmation is idempotent for the selected official website", () => {
  assert.equal(brandConfirmationAction(null, "https://example.com/"), "confirm");
  assert.equal(brandConfirmationAction("https://example.com/", "https://example.com/"), "already_confirmed");
  assert.equal(brandConfirmationAction("https://example.com/", "https://other.example/"), "conflict");
});

test("Resolve Gaps requires a confirmed identity without blocking failed resolution retry", () => {
  assert.equal(canResolveResearchGaps(null), false);
  assert.equal(canResolveResearchGaps({ name: "Canonical brand" }), true);
  assert.equal(canRetryFailedBrandResolution("failed", null, ["brand_resolution"]), true);
  assert.equal(canRetryFailedBrandResolution("awaiting_brand_confirmation", null, ["brand_resolution"]), false);
  assert.equal(canRetryFailedBrandResolution("failed", null, ["company_research"]), false);
  assert.equal(canRetryFailedBrandResolution("failed", { name: "Canonical brand" }, ["brand_resolution"]), false);
});

test("last attempt projection prefers retries and falls back for historical runs", () => {
  const requestedAt = new Date("2025-01-01T20:52:00.000Z");
  const retriedAt = new Date("2025-01-01T21:10:00.000Z");
  assert.equal(lastAttemptTimestamp(retriedAt, requestedAt), retriedAt);
  assert.equal(lastAttemptTimestamp(null, requestedAt), requestedAt);
  assert.equal(lastAttemptTimestamp(null, null), null);
});

test("competitor discovery excludes both canonical and entered brand aliases after confirmation", () => {
  const aliases = ["Hisense", "Hisence"];
  assert.equal(isSelfBrandCandidate("HISENSE", aliases), true);
  assert.equal(isSelfBrandCandidate("Hisence", aliases), true);
  assert.equal(isSelfBrandCandidate("Toshiba", aliases), false);
});