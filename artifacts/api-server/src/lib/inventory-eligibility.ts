/**
 * Single source of truth for "is this shelter / media unit part of the CURRENT
 * SkyBlue inventory?" Used wherever inventory can enter a pitch: new project
 * selections, media-plan proposal totals, and (later) Mockup creation.
 *
 * The rule matches the coverage/recommendation engine
 * (location-intelligence-coverage.ts): the asset must be active AND its source
 * lifecycle must be ACTIVE (not REMOVED, not MISSING_FROM_SOURCE), and a
 * selected media unit must itself be ACTIVE (e.g. "Mupi Removed" stays out).
 *
 * Historical project selections that reference ineligible inventory are never
 * deleted; they are reported with INACTIVE_INVENTORY_LABEL and excluded from
 * proposal totals.
 */

export const INACTIVE_INVENTORY_LABEL = "Inactive / Removed from current inventory";

export type CurrentInventoryStatus = "CURRENT" | "INACTIVE_REMOVED";

export type EligibilityAsset = {
  isActive: boolean;
  sourceLifecycleStatus: string;
};

export type EligibilityUnit = {
  lifecycleStatus: string;
};

export type InventoryEligibility = {
  inventoryStatus: CurrentInventoryStatus;
  inventoryStatusLabel: string | null;
  inventoryStatusReason: string | null;
};

export function isCurrentInventoryAsset(asset: EligibilityAsset): boolean {
  return asset.isActive === true && asset.sourceLifecycleStatus === "ACTIVE";
}

export function isCurrentInventoryUnit(unit: EligibilityUnit): boolean {
  return unit.lifecycleStatus === "ACTIVE";
}

function assetReason(asset: EligibilityAsset): string | null {
  if (asset.sourceLifecycleStatus === "REMOVED") return "Shelter marked removed in the source inventory.";
  if (asset.sourceLifecycleStatus === "MISSING_FROM_SOURCE") return "Shelter missing from the latest source inventory sync.";
  if (asset.sourceLifecycleStatus !== "ACTIVE") return `Shelter source lifecycle is ${asset.sourceLifecycleStatus}.`;
  if (!asset.isActive) return "Shelter is inactive in the current inventory.";
  return null;
}

/**
 * Evaluate a selection target. `unit` is null for an asset-level selection,
 * or undefined/null when a referenced unit no longer resolves (treated as
 * ineligible when `unitExpected` is true).
 */
export function evaluateInventoryEligibility(
  asset: EligibilityAsset,
  unit: EligibilityUnit | null | undefined,
  unitExpected = false,
): InventoryEligibility {
  const reason = assetReason(asset) ??
    (unitExpected && !unit ? "Selected media unit no longer exists in the current inventory." : null) ??
    (unit && !isCurrentInventoryUnit(unit) ? `Selected media unit is ${unit.lifecycleStatus.toLowerCase()} in the source inventory.` : null);
  return reason
    ? { inventoryStatus: "INACTIVE_REMOVED", inventoryStatusLabel: INACTIVE_INVENTORY_LABEL, inventoryStatusReason: reason }
    : { inventoryStatus: "CURRENT", inventoryStatusLabel: null, inventoryStatusReason: null };
}

export function isCurrentInventorySelection(
  asset: EligibilityAsset,
  unit: EligibilityUnit | null | undefined,
  unitExpected = false,
): boolean {
  return evaluateInventoryEligibility(asset, unit, unitExpected).inventoryStatus === "CURRENT";
}
