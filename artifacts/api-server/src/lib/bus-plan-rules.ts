export type BusPlanStatus = "PROPOSED" | "SHORTLISTED" | "REJECTED";

export type BusPlanOverrideEventData = {
  projectId: string;
  selectionId: string;
  priorQuantity: number | null;
  proposedQuantity: number;
  sourceBusCountSnapshot: number | null;
  reason: string;
  occurredAt: Date;
};

export function buildBusPlanOverrideEvent(
  event: BusPlanOverrideEventData,
): BusPlanOverrideEventData {
  return { ...event, reason: event.reason.trim() };
}

export function proposedBusTotal(rows: Array<{ status: BusPlanStatus; proposedQuantity: number }>): number {
  return rows.reduce((total, row) =>
    row.status === "REJECTED" ? total : total + row.proposedQuantity, 0);
}

export function requiresBusCountOverride(proposedQuantity: number, sourceBusCount: number | null): boolean {
  return sourceBusCount === null || proposedQuantity > sourceBusCount;
}

export function selectionRequiresBusCountOverride(
  proposedQuantity: number,
  sourceBusCount: number | null,
  overrideSourceCount: boolean,
  overrideCountSnapshot: number | null,
): boolean {
  return requiresBusCountOverride(proposedQuantity, sourceBusCount) &&
    (!overrideSourceCount || overrideCountSnapshot !== sourceBusCount);
}

export function projectSelectionBelongsToProject(
  selectionProjectId: string,
  requestedProjectId: string,
): boolean {
  return selectionProjectId === requestedProjectId;
}

export function validateProposedQuantity(quantity: number): boolean {
  return Number.isSafeInteger(quantity) && quantity > 0;
}