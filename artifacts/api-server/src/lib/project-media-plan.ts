export type ProjectShelterSelectionStatus = "shortlist" | "selected" | "rejected";

export function isBusShelterSourceFamily(sourceFamily: string): boolean {
  return sourceFamily === "BUS_SHELTER";
}

export type CampaignGeographyStatus =
  | "IN_CAMPAIGN_GEOGRAPHY"
  | "OUTSIDE_CAMPAIGN_GEOGRAPHY"
  | "UNVERIFIED_CAMPAIGN_GEOGRAPHY";

export function campaignGeographyStatusFromEvidence(
  isInCampaignGeography: boolean,
  isOutsideCampaignGeography: boolean,
): CampaignGeographyStatus {
  if (isInCampaignGeography) return "IN_CAMPAIGN_GEOGRAPHY";
  if (isOutsideCampaignGeography) return "OUTSIDE_CAMPAIGN_GEOGRAPHY";
  return "UNVERIFIED_CAMPAIGN_GEOGRAPHY";
}

export type CampaignScopedBusSelection = {
  status: "PROPOSED" | "SHORTLISTED" | "REJECTED";
  proposedQuantity: number;
  campaignGeographyStatus: CampaignGeographyStatus;
};

export function campaignScopedProposedBusTotal(selections: CampaignScopedBusSelection[]): number {
  return selections.reduce((total, selection) => {
    if (selection.status === "REJECTED" || selection.campaignGeographyStatus !== "IN_CAMPAIGN_GEOGRAPHY") {
      return total;
    }
    return total + selection.proposedQuantity;
  }, 0);
}

/**
 * Splits exact BUS_SHELTER selections into:
 *  - proposed: not rejected AND still in current inventory (the only rows that
 *    count toward proposal totals and may be used for mockups later);
 *  - rejected: explicitly rejected by the planner (never counted);
 *  - inactive: historical, non-rejected selections whose shelter or media unit
 *    is no longer in current inventory. Preserved for audit, never counted.
 */
export function partitionShelterSelections<T extends {
  status: ProjectShelterSelectionStatus;
  inventoryMediaUnitId: string | null;
  mediaUnitType: string | null;
  inventoryStatus: "CURRENT" | "INACTIVE_REMOVED";
}>(selections: T[]): {
  proposedShelterSelections: T[];
  rejectedShelterSelections: T[];
  inactiveShelterSelections: T[];
} {
  return {
    proposedShelterSelections: selections.filter((selection) =>
      selection.status !== "rejected" && selection.inventoryStatus === "CURRENT"),
    rejectedShelterSelections: selections.filter((selection) => selection.status === "rejected"),
    inactiveShelterSelections: selections.filter((selection) =>
      selection.status !== "rejected" && selection.inventoryStatus !== "CURRENT"),
  };
}
