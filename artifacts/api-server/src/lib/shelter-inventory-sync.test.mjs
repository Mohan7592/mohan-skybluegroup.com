import assert from "node:assert/strict";
import test from "node:test";
const {
  normalizeShelterMediaType,
  normalizeShelterNumber,
  parseShelterCoordinates,
  isShelterRemoved,
  shelterMediaPlan,
  shelterSourceKey,
  parseShelterSourceRow,
  compareShelterMediaUnit,
  compareShelterRecord,
  parseShelterCampaignDate,
} = await import("./shelter-source-rules.ts");
import { rowsFromValues, SHELTER_REQUIRED_HEADERS } from "./shelter-google-sheets.ts";

test("normalizes source typo while keeping digital categories distinct", () => {
  assert.equal(normalizeShelterMediaType("Standared"), "Standard");
  assert.equal(normalizeShelterMediaType("Digital Bus Shelter"), "Digital Bus Shelter");
  assert.equal(normalizeShelterMediaType("Digital Mupi"), "Digital Mupi");
  assert.equal(normalizeShelterMediaType("Digital BS & Mupi"), "Digital BS & Mupi");
});

test("stores canonical source media type and preserves the original typo", () => {
  const parsed = parseShelterSourceRow("Single", {
    "Shelter No": "S-1",
    Type: "Standared",
    Coordinates: "25.2, 55.3",
  });
  assert.equal(parsed?.values.sourceMediaType, "Standard");
  assert.equal(parsed?.values.assetTypeOriginal, "Standared");
  assert.equal(parsed?.values.rawImportData?.Type, "Standared");
});

test("separate Double A and B shelter numbers remain separate stable keys", () => {
  assert.equal(normalizeShelterNumber(" 128  A "), "128-A");
  assert.notEqual(shelterSourceKey("Double", "128 A"), shelterSourceKey("Double", "128-B"));
  assert.equal(shelterSourceKey("Double", "128 A"), "BUS_SHELTER:DOUBLE:128-A");
});

test("strict coordinate parser rejects malformed and out-of-range strings", () => {
  assert.deepEqual(parseShelterCoordinates("25.2048, 55.2708"), {
    latitude: 25.2048,
    longitude: 55.2708,
    valid: true,
  });
  assert.deepEqual(parseShelterCoordinates("25.2, 55.3 approx"), {
    latitude: null,
    longitude: null,
    valid: false,
  });
  assert.equal(parseShelterCoordinates("91, 55").valid, false);
});

test("sheet campaign dates are parsed only with an unambiguous year and valid day", () => {
  assert.equal(parseShelterCampaignDate("01/Jan/2026"), "2026-01-01");
  assert.equal(parseShelterCampaignDate("22-Nov-2025"), "2025-11-22");
  assert.equal(parseShelterCampaignDate("11-February-2026"), "2026-02-11");
  assert.equal(parseShelterCampaignDate("11/25/2025"), "2025-11-25");
  assert.equal(parseShelterCampaignDate("1 Mar"), null);
  assert.equal(parseShelterCampaignDate("01/02/2026"), null);
  assert.equal(parseShelterCampaignDate("31/Feb/2026"), null);
  assert.equal(parseShelterCampaignDate("2026-01-31"), "2026-01-31");
});

test("JSONB source fields compare by value, not object key order", () => {
  const before = { rawImportData: { B: "2", A: "1" }, sourceRecordHash: "old", lastSeenAt: new Date() };
  const after = { rawImportData: { A: "1", B: "2" }, sourceRecordHash: "new", lastSeenAt: new Date() };
  assert.deepEqual(compareShelterRecord(before, after), {});
  assert.deepEqual(compareShelterRecord(before, { ...after, rawImportData: { A: "changed", B: "2" } }), {
    rawImportData: { before: before.rawImportData, after: { A: "changed", B: "2" } },
  });
});

test("removal categories distinguish removed shelter from removed MUPI", () => {
  assert.equal(isShelterRemoved(null, "Shelter Removed"), true);
  assert.equal(isShelterRemoved("SB/Removed", null), true);
  assert.equal(isShelterRemoved(null, "Mupi Removed"), false);
  const mupiOnly = shelterMediaPlan("Standard", "Mupi Removed");
  assert.equal(mupiOnly.find((unit) => unit.unitType === "MUPI")?.lifecycleStatus, "REMOVED");
  assert.equal(mupiOnly.find((unit) => unit.unitType === "TOP_PANEL")?.lifecycleStatus, "ACTIVE");
});

test("Mupi Removed in remarks removes only its MUPI even when Mupi equals 1", () => {
  const parsed = parseShelterSourceRow("Single", {
    "Shelter No": "S-2",
    Type: "Digital Bus Shelter",
    Mupi: "1",
    Remarks: "Mupi Removed",
    Coordinates: "25.2, 55.3",
  });
  assert.equal(parsed?.values.isActive, true);
  assert.equal(parsed?.mediaUnits.find((unit) => unit.unitType === "TOP_PANEL")?.lifecycleStatus, "ACTIVE");
  assert.equal(parsed?.mediaUnits.find((unit) => unit.unitType === "MUPI")?.lifecycleStatus, "REMOVED");
});

test("explicit shelter removal removes child units but retains source media details", () => {
  const parsed = parseShelterSourceRow("Double", {
    "Shelter No": "128 A",
    Type: "Digital BS & Mupi",
    Mupi: "1",
    Remarks: "Shelter Removed",
    Coordinates: "25.2, 55.3",
  });
  assert.equal(parsed?.values.isActive, false);
  assert.deepEqual(parsed?.mediaUnits.map(({ unitType, format, sourceType, lifecycleStatus }) => ({
    unitType, format, sourceType, lifecycleStatus,
  })), [
    { unitType: "TOP_PANEL", format: "DIGITAL", sourceType: "Digital BS & Mupi", lifecycleStatus: "REMOVED" },
    { unitType: "MUPI", format: "DIGITAL", sourceType: "Digital BS & Mupi", lifecycleStatus: "REMOVED" },
  ]);
});

test("media-only field changes are auditable and identical units produce no update", () => {
  const current = {
    format: "STATIC",
    sourceType: "Standard",
    availabilityStatus: "UNKNOWN",
    lifecycleStatus: "ACTIVE",
    currentClient: null,
    campaignStart: null,
    campaignEnd: null,
    internalNotes: null,
  };
  const desired = { ...current, lifecycleStatus: "REMOVED", internalNotes: "Mupi Removed in source" };
  assert.deepEqual(compareShelterMediaUnit("MUPI", current, desired), {
    "mediaUnits.MUPI.lifecycleStatus": { before: "ACTIVE", after: "REMOVED" },
    "mediaUnits.MUPI.internalNotes": { before: null, after: "Mupi Removed in source" },
  });
  assert.deepEqual(compareShelterMediaUnit("MUPI", current, current), {});
});

test("tab parser rejects an incomplete tab and retains only rows with shelter number", () => {
  assert.throws(() => rowsFromValues([["Area"], ["A"]], "Single"), /Shelter No/);
  const headers = SHELTER_REQUIRED_HEADERS.Single;
  const shelterIndex = headers.indexOf("Shelter No");
  const values = headers.map(() => "");
  const populated = [...values];
  populated[shelterIndex] = "S1";
  assert.deepEqual(rowsFromValues([headers, values, populated], "Single"), [
    Object.fromEntries(headers.map((header, index) => [header, populated[index]])),
  ]);
  for (const critical of ["Accountability", "Type", "Mupi", "Remark"]) {
    const reduced = headers.filter((header) => header !== critical);
    assert.throws(() => rowsFromValues([reduced, reduced.map(() => "S1")], "Single"), new RegExp(critical));
  }
});