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

export function partitionShelterSelections<T extends {
  status: ProjectShelterSelectionStatus;
  inventoryMediaUnitId: string | null;
  mediaUnitType: string | null;
}>(selections: T[]): {
  proposedShelterSelections: T[];
  rejectedShelterSelections: T[];
} {
  return {
    proposedShelterSelections: selections.filter((selection) => selection.status !== "rejected"),
    rejectedShelterSelections: selections.filter((selection) => selection.status === "rejected"),
  };
}