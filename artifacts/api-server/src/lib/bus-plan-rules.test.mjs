import assert from "node:assert/strict";
import test from "node:test";
import {
  buildBusPlanOverrideEvent,
  projectSelectionBelongsToProject,
  proposedBusTotal,
  requiresBusCountOverride,
  selectionRequiresBusCountOverride,
  validateProposedQuantity,
} from "./bus-plan-rules.ts";

test("proposed bus totals include shortlisted rows but exclude rejected rows", () => {
  assert.equal(proposedBusTotal([
    { status: "PROPOSED", proposedQuantity: 7 },
    { status: "SHORTLISTED", proposedQuantity: 5 },
    { status: "REJECTED", proposedQuantity: 4 },
  ]), 12);
});

test("missing and exceeded route counts require an explicit override", () => {
  assert.equal(requiresBusCountOverride(7, 7), false);
  assert.equal(requiresBusCountOverride(8, 7), true);
  assert.equal(requiresBusCountOverride(1, null), true);
  assert.equal(selectionRequiresBusCountOverride(7, 5, false, null), true);
  assert.equal(selectionRequiresBusCountOverride(7, 5, true, 7), true);
  assert.equal(selectionRequiresBusCountOverride(7, 5, true, 5), false);
  assert.equal(validateProposedQuantity(1), true);
  assert.equal(validateProposedQuantity(0), false);
  assert.equal(validateProposedQuantity(1.5), false);
});

test("a project selection is never owned by a different project", () => {
  assert.equal(projectSelectionBelongsToProject("project-a", "project-a"), true);
  assert.equal(projectSelectionBelongsToProject("project-a", "project-b"), false);
});

test("accepted overrides capture append-only audit facts including the prior quantity", () => {
  const occurredAt = new Date("2026-02-03T04:05:06.000Z");
  const event = buildBusPlanOverrideEvent({
    projectId: "project-a",
    selectionId: "selection-a",
    priorQuantity: 7,
    proposedQuantity: 9,
    sourceBusCountSnapshot: 5,
    reason: "  Pitch exception  ",
    occurredAt,
  });
  assert.deepEqual(event, {
    projectId: "project-a",
    selectionId: "selection-a",
    priorQuantity: 7,
    proposedQuantity: 9,
    sourceBusCountSnapshot: 5,
    reason: "Pitch exception",
    occurredAt,
  });
  const creationOverride = buildBusPlanOverrideEvent({
    ...event,
    priorQuantity: null,
    proposedQuantity: 4,
    sourceBusCountSnapshot: null,
  });
  assert.equal(creationOverride.priorQuantity, null);
  assert.equal(creationOverride.sourceBusCountSnapshot, null);
});