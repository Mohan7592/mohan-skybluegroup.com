import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./location-copilot.ts", import.meta.url), "utf8");
const start = source.indexOf("export function isLocationCopilotQuestion");
const end = source.indexOf("\n}\n\nfunction explicitRadius", start);
assert.notEqual(start, -1);
assert.notEqual(end, -1);
const functionSource = source.slice(start, end + 2)
  .replace("export function", "function")
  .replace("(question: string): boolean", "(question)");
const intentFunction = new Function(`${functionSource}; return isLocationCopilotQuestion;`)();

function bodyAfter(marker, bodyStart) {
  const declaration = source.indexOf(marker);
  assert.notEqual(declaration, -1, marker);
  const startBody = source.indexOf(bodyStart, declaration);
  const endBody = source.indexOf("\n}", startBody);
  assert.notEqual(startBody, -1, bodyStart);
  assert.notEqual(endBody, -1);
  return source.slice(startBody, endBody);
}

const currentPredicate = new Function("recommendation", "record",
  bodyAfter("export function isCurrentRecommendation", "  return record(recommendation).isCurrent === true;"));
const shortlistPredicate = new Function("item", "current",
  bodyAfter("export function canShortlistLocationRecommendation", "  return isCurrentRecommendation(item.recommendation) &&")
    .replaceAll("isCurrentRecommendation(", "current("));
const areaOnlyPredicate = new Function("recommendation", "record",
  bodyAfter("export function isAreaOnlyLocationRecommendation", "  const details = record(recommendation.explanation);"));

test("location copilot recognizes supported saved-location planning intents", () => {
  for (const question of [
    "Where should we focus for this client?",
    "Show shelters within 500m of Talabat-relevant locations",
    "Only show digital top panels",
    "Why did you recommend Shelter 457A?",
    "Show competitor-nearby shelters",
    "Which bus routes cover the target areas?",
    "Give me a focused bus plan",
    "Add these three shelters to shortlist",
    "What information is missing before I present this plan?",
  ]) {
    assert.equal(intentFunction(question), true, question);
  }
});

test("explicit route additions remain on the established bus-plan handler", () => {
  assert.equal(intentFunction("Add Route X with 5 proposed buses"), false);
});

test("only current, active, clean, non-rejected active shelter units can be shortlisted", () => {
  const item = {
    recommendation: { isCurrent: true, decision: "UNREVIEWED" },
    asset: { isActive: true, sourceLifecycleStatus: "ACTIVE", assetType: "Bus Shelter", syncReviewReasons: [] },
    unit: { lifecycleStatus: "ACTIVE" },
  };
  const current = (recommendation) => currentPredicate(recommendation, (value) => value);
  assert.equal(current(item.recommendation), true);
  assert.equal(shortlistPredicate(item, current), true);
  assert.equal(current({ isCurrent: false }), false);
  for (const invalid of [
    { recommendation: { ...item.recommendation, decision: "REJECTED" } },
    { recommendation: { ...item.recommendation, isCurrent: false } },
    { asset: { ...item.asset, isActive: false } },
    { asset: { ...item.asset, sourceLifecycleStatus: "REMOVED" } },
    { asset: { ...item.asset, syncReviewReasons: ["review required"] } },
    { unit: { lifecycleStatus: "INACTIVE" } },
  ]) {
    assert.equal(shortlistPredicate({ ...item, ...invalid }, current), false);
  }
});

test("area/road-only recommendations are identified without inventing proximity", () => {
  assert.equal(areaOnlyPredicate({
    explanation: { distanceMeters: null },
    reasons: ["Located in approved target area Downtown."],
  }, (value) => value), true);
  assert.equal(areaOnlyPredicate({
    explanation: { distanceMeters: 12 },
    reasons: ["Located in approved target area Downtown."],
  }, (value) => value), false);
});