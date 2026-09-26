import { and, desc, eq } from "drizzle-orm";
import {
  busPlanOverrideEventsTable,
  busRouteSourceRowsTable,
  busRoutesTable,
  db,
  pitchProjectsTable,
  projectBusRouteSelectionsTable,
  projectLocationStrategiesTable,
} from "@workspace/db";
import {
  buildBusPlanOverrideEvent,
  projectSelectionBelongsToProject,
  requiresBusCountOverride,
  selectionRequiresBusCountOverride,
  validateProposedQuantity,
  type BusPlanStatus,
} from "./bus-plan-rules";
import { campaignScopedProposedBusTotal } from "./project-media-plan";
import {
  campaignGeographyStatus,
  routeHasCampaignGeographyEvidence,
  type CampaignGeography,
  type CampaignGeographyStatus,
} from "./location-market-scope";

export type AddProjectBusRouteInput = {
  sourceVariantId: string;
  proposedQuantity: number;
  status?: BusPlanStatus;
  internalNote?: string | null;
  overrideSourceCount?: boolean;
  overrideReason?: string | null;
};

export type UpdateProjectBusRouteInput = {
  proposedQuantity?: number;
  status?: BusPlanStatus;
  internalNote?: string | null;
  overrideSourceCount?: boolean;
  overrideReason?: string | null;
};

export type ProjectBusRouteSelectionView = {
  id: string;
  projectId: string;
  sourceVariantId: string;
  routeId: string;
  from: string | null;
  to: string | null;
  via: string | null;
  depot: string | null;
  sourceBusCount: number | null;
  sourceSheet: string;
  sourceRow: number;
  lastSeenAt: Date | null;
  originalSourceData: Record<string, unknown>;
  isSourceActive: boolean;
  campaignGeographyStatus: CampaignGeographyStatus;
  proposedQuantity: number;
  requiresOverride: boolean;
  status: BusPlanStatus;
  internalNote: string | null;
  overrideSourceCount: boolean;
  overrideReason: string | null;
  overrideAt: Date | null;
  overrideCountSnapshot: number | null;
  createdAt: Date;
  updatedAt: Date;
};

export type ProjectBusPlanView = {
  projectId: string;
  selections: ProjectBusRouteSelectionView[];
  totalProposedBuses: number;
};

type ProjectCampaignScope = {
  geography: CampaignGeography | null;
  areas: string[];
  approvedTargetAreas: string[];
};

async function getProjectCampaignScope(projectId: string): Promise<ProjectCampaignScope | null> {
  const [project] = await db.select({
    id: pitchProjectsTable.id,
    geography: pitchProjectsTable.campaignGeography,
    areas: pitchProjectsTable.campaignAreas,
  }).from(pitchProjectsTable)
    .where(eq(pitchProjectsTable.id, projectId)).limit(1);
  if (!project) return null;
  const [strategy] = await db.select({
    status: projectLocationStrategiesTable.status,
    targetAreas: projectLocationStrategiesTable.targetAreas,
  }).from(projectLocationStrategiesTable)
    .where(eq(projectLocationStrategiesTable.projectId, projectId)).limit(1);
  return {
    geography: project.geography,
    areas: project.areas,
    approvedTargetAreas: strategy?.status === "APPROVED" ? strategy.targetAreas : [],
  };
}

function routeCampaignGeographyStatus(routeText: string, scope: ProjectCampaignScope): CampaignGeographyStatus {
  if (routeHasCampaignGeographyEvidence(
    routeText,
    scope.geography,
    scope.areas,
    scope.approvedTargetAreas,
  )) {
    return "IN_CAMPAIGN_GEOGRAPHY";
  }
  const status = campaignGeographyStatus(
    { name: routeText, area: null, address: null },
    scope.geography,
    scope.areas,
  );
  if (status === "OUTSIDE_CAMPAIGN_GEOGRAPHY") return status;
  if (scope.geography === "DUBAI" || scope.geography === "ABU_DHABI") {
    const emirates = ["abu dhabi", "dubai", "sharjah", "ajman", "umm al quwain", "ras al khaimah", "fujairah"];
    const inScopeEmirate = scope.geography === "DUBAI" ? "dubai" : "abu dhabi";
    if (emirates.some((emirate) =>
      emirate !== inScopeEmirate &&
      new RegExp(`\\b${emirate.replace(/ /g, "\\s+")}\\b`, "i").test(routeText))) {
      return "OUTSIDE_CAMPAIGN_GEOGRAPHY";
    }
  }
  return "UNVERIFIED_CAMPAIGN_GEOGRAPHY";
}

export class BusPlanServiceError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409,
    readonly requiresOverride = false,
    readonly sourceBusCount: number | null = null,
  ) {
    super(message);
    this.name = "BusPlanServiceError";
  }
}

function sourceValue(rawData: Record<string, unknown>, ...headers: string[]): string | null {
  const normalizedHeaders = new Set(headers.map((header) => header.toLocaleLowerCase().replace(/[^a-z0-9]/g, "")));
  for (const [header, value] of Object.entries(rawData)) {
    if (!normalizedHeaders.has(header.toLocaleLowerCase().replace(/[^a-z0-9]/g, ""))) continue;
    if (value == null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return null;
}

function mapSelection(
  selection: typeof projectBusRouteSelectionsTable.$inferSelect,
  source: typeof busRouteSourceRowsTable.$inferSelect,
  route: typeof busRoutesTable.$inferSelect,
  scope: ProjectCampaignScope,
): ProjectBusRouteSelectionView {
  const from = sourceValue(source.rawData, "Starting Station", "From");
  const to = sourceValue(source.rawData, "Ending station", "Ending Station", "To");
  const via = sourceValue(source.rawData, "Via");
  return {
    id: selection.id,
    projectId: selection.projectId,
    sourceVariantId: source.id,
    routeId: route.routeId,
    from,
    to,
    via,
    depot: sourceValue(source.rawData, "Depot Name", "Depot"),
    sourceBusCount: source.allocatedBusCount,
    sourceSheet: source.sheetName,
    sourceRow: source.sourceRowNumber,
    lastSeenAt: source.lastSeenAt,
    originalSourceData: source.rawData,
    isSourceActive: source.isActive && route.isActive,
    campaignGeographyStatus: routeCampaignGeographyStatus(
      [from, to, via].filter((value): value is string => Boolean(value?.trim())).join(" "),
      scope,
    ),
    proposedQuantity: selection.proposedQuantity,
    requiresOverride: selectionRequiresBusCountOverride(
      selection.proposedQuantity,
      source.allocatedBusCount,
      selection.overrideSourceCount,
      selection.overrideCountSnapshot,
    ),
    status: selection.status as BusPlanStatus,
    internalNote: selection.internalNote,
    overrideSourceCount: selection.overrideSourceCount,
    overrideReason: selection.overrideReason,
    overrideAt: selection.overrideAt,
    overrideCountSnapshot: selection.overrideCountSnapshot,
    createdAt: selection.createdAt,
    updatedAt: selection.updatedAt,
  };
}

async function selectionDetails(projectId: string, selectionId?: string) {
  const conditions = selectionId
    ? and(eq(projectBusRouteSelectionsTable.projectId, projectId), eq(projectBusRouteSelectionsTable.id, selectionId))
    : eq(projectBusRouteSelectionsTable.projectId, projectId);
  return db.select({
    selection: projectBusRouteSelectionsTable,
    source: busRouteSourceRowsTable,
    route: busRoutesTable,
  }).from(projectBusRouteSelectionsTable)
    .innerJoin(busRouteSourceRowsTable, eq(projectBusRouteSelectionsTable.sourceVariantId, busRouteSourceRowsTable.id))
    .innerJoin(busRoutesTable, eq(busRouteSourceRowsTable.busRouteId, busRoutesTable.id))
    .where(conditions)
    .orderBy(desc(projectBusRouteSelectionsTable.updatedAt));
}

async function requireProject(projectId: string): Promise<void> {
  const [project] = await db.select({ id: pitchProjectsTable.id }).from(pitchProjectsTable)
    .where(eq(pitchProjectsTable.id, projectId)).limit(1);
  if (!project) throw new BusPlanServiceError("Project not found", 404);
}

function ensureOverride(
  proposedQuantity: number,
  sourceBusCount: number | null,
  explicitOverride: boolean | undefined,
  reason: string | null | undefined,
): void {
  if (reason?.trim() && explicitOverride !== true) {
    throw new BusPlanServiceError("overrideSourceCount must be true when an override reason is supplied", 400);
  }
  if (explicitOverride === true && !reason?.trim()) {
    throw new BusPlanServiceError("overrideReason is required when overrideSourceCount is true", 400);
  }
  if (requiresBusCountOverride(proposedQuantity, sourceBusCount) && explicitOverride !== true) {
    throw new BusPlanServiceError(
      "Proposed quantity exceeds or has no source bus count; explicit override and reason required",
      409,
      true,
      sourceBusCount,
    );
  }
}

export async function getProjectBusPlan(projectId: string): Promise<ProjectBusPlanView | null> {
  const scope = await getProjectCampaignScope(projectId);
  if (!scope) return null;
  const rows = await selectionDetails(projectId);
  const selections = rows.map(({ selection, source, route }) => mapSelection(selection, source, route, scope));
  return {
    projectId,
    selections,
    totalProposedBuses: campaignScopedProposedBusTotal(selections),
  };
}

export async function addProjectBusRoute(
  projectId: string,
  input: AddProjectBusRouteInput,
): Promise<ProjectBusRouteSelectionView> {
  await requireProject(projectId);
  if (!validateProposedQuantity(input.proposedQuantity)) {
    throw new BusPlanServiceError("proposedQuantity must be a positive integer", 400);
  }
  let result: {
    selection: typeof projectBusRouteSelectionsTable.$inferSelect;
    variant: typeof busRouteSourceRowsTable.$inferSelect;
    route: typeof busRoutesTable.$inferSelect;
  };
  try {
    result = await db.transaction(async (tx) => {
      const [currentVariant] = await tx.select().from(busRouteSourceRowsTable)
        .where(and(eq(busRouteSourceRowsTable.id, input.sourceVariantId), eq(busRouteSourceRowsTable.isActive, true)))
        .for("update").limit(1);
      if (!currentVariant) throw new BusPlanServiceError("Active bus route source variant not found", 404);
      ensureOverride(input.proposedQuantity, currentVariant.allocatedBusCount, input.overrideSourceCount, input.overrideReason);
      const [currentRoute] = await tx.select().from(busRoutesTable)
        .where(and(
          eq(busRoutesTable.id, currentVariant.busRouteId),
          eq(busRoutesTable.isActive, true),
        )).limit(1);
      if (!currentRoute) throw new BusPlanServiceError("Active bus route source variant not found", 404);
      const [existing] = await tx.select({ id: projectBusRouteSelectionsTable.id })
        .from(projectBusRouteSelectionsTable)
        .where(and(
          eq(projectBusRouteSelectionsTable.projectId, projectId),
          eq(projectBusRouteSelectionsTable.sourceVariantId, input.sourceVariantId),
        )).limit(1);
      if (existing) throw new BusPlanServiceError("This route source variant is already in the project bus plan", 409);
      const overrideAt = input.overrideSourceCount ? new Date() : null;
      const [selection] = await tx.insert(projectBusRouteSelectionsTable).values({
        projectId,
        sourceVariantId: input.sourceVariantId,
        proposedQuantity: input.proposedQuantity,
        status: input.status ?? "PROPOSED",
        internalNote: input.internalNote ?? null,
        overrideSourceCount: input.overrideSourceCount === true,
        overrideReason: input.overrideSourceCount ? input.overrideReason!.trim() : null,
        overrideAt,
        overrideCountSnapshot: input.overrideSourceCount ? currentVariant.allocatedBusCount : null,
      }).returning();
      if (!selection) throw new BusPlanServiceError("Could not create bus route selection", 409);
      if (input.overrideSourceCount) {
        await tx.insert(busPlanOverrideEventsTable).values(buildBusPlanOverrideEvent({
          projectId,
          selectionId: selection.id,
          priorQuantity: null,
          proposedQuantity: input.proposedQuantity,
          sourceBusCountSnapshot: currentVariant.allocatedBusCount,
          reason: input.overrideReason!,
          occurredAt: overrideAt!,
        }));
      }
      return { selection, variant: currentVariant, route: currentRoute };
    });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error &&
      (error as { code?: unknown }).code === "23505") {
      throw new BusPlanServiceError("This route source variant is already in the project bus plan", 409);
    }
    throw error;
  }
  const scope = await getProjectCampaignScope(projectId);
  if (!scope) throw new BusPlanServiceError("Project not found", 404);
  return mapSelection(result.selection, result.variant, result.route, scope);
}

export async function updateProjectBusRoute(
  projectId: string,
  selectionId: string,
  input: UpdateProjectBusRouteInput,
): Promise<ProjectBusRouteSelectionView> {
  await requireProject(projectId);
  if (input.proposedQuantity !== undefined && !validateProposedQuantity(input.proposedQuantity)) {
    throw new BusPlanServiceError("proposedQuantity must be a positive integer", 400);
  }
  if (!Object.keys(input).length) throw new BusPlanServiceError("At least one update field is required", 400);
  const result = await db.transaction(async (tx) => {
    const [current] = await tx.select({
      selection: projectBusRouteSelectionsTable,
      source: busRouteSourceRowsTable,
      route: busRoutesTable,
    }).from(projectBusRouteSelectionsTable)
      .innerJoin(busRouteSourceRowsTable, eq(projectBusRouteSelectionsTable.sourceVariantId, busRouteSourceRowsTable.id))
      .innerJoin(busRoutesTable, eq(busRouteSourceRowsTable.busRouteId, busRoutesTable.id))
      .where(and(
        eq(projectBusRouteSelectionsTable.projectId, projectId),
        eq(projectBusRouteSelectionsTable.id, selectionId),
      ))
      .for("update").limit(1);
    if (!current) throw new BusPlanServiceError("Project bus route selection not found", 404);
    const quantity = input.proposedQuantity ?? current.selection.proposedQuantity;
    const countCheckRequested = input.proposedQuantity !== undefined || input.overrideSourceCount === true;
    if (countCheckRequested) {
      ensureOverride(quantity, current.source.allocatedBusCount, input.overrideSourceCount, input.overrideReason);
    } else if (input.overrideReason?.trim()) {
      throw new BusPlanServiceError("overrideSourceCount must be true when an override reason is supplied", 400);
    }

    const now = new Date();
    const set: Partial<typeof projectBusRouteSelectionsTable.$inferInsert> = { updatedAt: now };
    if (input.proposedQuantity !== undefined) set.proposedQuantity = input.proposedQuantity;
    if (input.status !== undefined) set.status = input.status;
    if (input.internalNote !== undefined) set.internalNote = input.internalNote;
    if (input.overrideSourceCount === true) {
      set.overrideSourceCount = true;
      set.overrideReason = input.overrideReason!.trim();
      set.overrideAt = now;
      set.overrideCountSnapshot = current.source.allocatedBusCount;
    }
    const [updated] = await tx.update(projectBusRouteSelectionsTable).set(set)
      .where(and(
        eq(projectBusRouteSelectionsTable.projectId, projectId),
        eq(projectBusRouteSelectionsTable.id, selectionId),
      )).returning();
    if (!updated) throw new BusPlanServiceError("Project bus route selection not found", 404);
    if (input.overrideSourceCount) {
      await tx.insert(busPlanOverrideEventsTable).values(buildBusPlanOverrideEvent({
        projectId,
        selectionId,
        priorQuantity: current.selection.proposedQuantity,
        proposedQuantity: updated.proposedQuantity,
        sourceBusCountSnapshot: current.source.allocatedBusCount,
        reason: input.overrideReason!,
        occurredAt: now,
      }));
    }
    return { selection: updated, source: current.source, route: current.route };
  });
  const scope = await getProjectCampaignScope(projectId);
  if (!scope) throw new BusPlanServiceError("Project not found", 404);
  return mapSelection(result.selection, result.source, result.route, scope);
}

export async function removeProjectBusRoute(projectId: string, selectionId: string): Promise<boolean> {
  const [selection] = await db.select({
    id: projectBusRouteSelectionsTable.id,
    projectId: projectBusRouteSelectionsTable.projectId,
  }).from(projectBusRouteSelectionsTable)
    .where(eq(projectBusRouteSelectionsTable.id, selectionId)).limit(1);
  if (!selection || !projectSelectionBelongsToProject(selection.projectId, projectId)) return false;
  const [removed] = await db.delete(projectBusRouteSelectionsTable).where(and(
    eq(projectBusRouteSelectionsTable.projectId, projectId),
    eq(projectBusRouteSelectionsTable.id, selectionId),
  )).returning({ id: projectBusRouteSelectionsTable.id });
  return Boolean(removed);
}