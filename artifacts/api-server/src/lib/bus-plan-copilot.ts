import { and, eq } from "drizzle-orm";
import { busRouteSourceRowsTable, busRoutesTable, db } from "@workspace/db";
import {
  addProjectBusRoute,
  BusPlanServiceError,
  getProjectBusPlan,
} from "./bus-plan-service";

export function isProjectBusPlanQuestion(question: string): boolean {
  return /\b(?:add|include|put)\s+route\s+[a-z0-9-]+/i.test(question) ||
    /\b(?:how many|total)\b.*\bbuses?\b.*\b(?:proposed|pitch)\b/i.test(question) ||
    /\b(?:which|what)\s+depots?\b.*\b(?:pitch|plan)\b/i.test(question) ||
    /\b(?:which|what|show)\s+routes?\b.*\b(?:pitch|plan|proposed)\b/i.test(question);
}

export async function answerProjectBusPlanQuestion(projectId: string, question: string): Promise<string | null> {
  if (!isProjectBusPlanQuestion(question)) return null;
  const add = question.match(/\b(?:add|include|put)\s+route\s+([a-z0-9-]+)\b.*?\b(\d+)\s+(?:proposed\s+)?buses?\b/i);
  if (add) {
    const routeId = add[1];
    const quantity = Number(add[2]);
    const [route] = await db.select().from(busRoutesTable)
      .where(and(eq(busRoutesTable.normalizedRouteId, routeId.toLowerCase()), eq(busRoutesTable.isActive, true))).limit(1);
    if (!route) return `Route ${routeId.toUpperCase()} was not found in the active Bus Routes source. No route was added.`;
    const variants = await db.select().from(busRouteSourceRowsTable)
      .where(and(eq(busRouteSourceRowsTable.busRouteId, route.id), eq(busRouteSourceRowsTable.isActive, true)));
    const mentioned = variants.filter((variant) => {
      const depot = String(variant.rawData["Depot Name"] ?? "").trim();
      const sourceRow = variant.sourceRowNumber;
      return (depot && question.toLowerCase().includes(depot.toLowerCase())) ||
        new RegExp(`\\b(?:source\\s+)?row\\s+${sourceRow}\\b`, "i").test(question);
    });
    const candidates = mentioned.length ? mentioned : variants;
    if (candidates.length !== 1) {
      const options = candidates.map((variant) => {
        const depot = String(variant.rawData["Depot Name"] ?? "Depot not supplied");
        return `${depot}, ${variant.sheetName.trim()} row ${variant.sourceRowNumber} (source buses: ${variant.allocatedBusCount ?? "not supplied"})`;
      });
      return `Route ${route.routeId} has ${candidates.length} source variants. Please specify the depot or source row in your add request. No route was added.\n${options.join("\n")}`;
    }
    const variant = candidates[0];
    const overrideSourceCount = /\boverride\b/i.test(question);
    const overrideReason = question.match(/\bbecause\s+(.+)$/i)?.[1]?.trim() ?? null;
    try {
      const added = await addProjectBusRoute(projectId, {
        sourceVariantId: variant.id,
        proposedQuantity: quantity,
        overrideSourceCount,
        overrideReason,
      });
      return `Added Route ${added.routeId} (${added.depot ?? "depot not supplied"}, ${added.sourceSheet.trim()} row ${added.sourceRow}) to this pitch: ${added.proposedQuantity} proposed buses, source buses: ${added.sourceBusCount ?? "not supplied"}.${added.overrideSourceCount ? ` Explicit source-count override recorded: ${added.overrideReason}.` : ""} Proposed buses are not reserved or confirmed.`;
    } catch (error) {
      if (error instanceof BusPlanServiceError) {
        if (error.requiresOverride) return `No route was added. The proposed quantity (${quantity}) exceeds Route ${route.routeId}'s source-row bus count (${error.sourceBusCount ?? "not supplied"}). An editor must explicitly override with a reason (for example, “Add Route ${route.routeId} ${String(variant.rawData["Depot Name"] ?? "")} with ${quantity} proposed buses, override because [reason]”).`;
        return `No route was added: ${error.message}.`;
      }
      throw error;
    }
  }
  const plan = await getProjectBusPlan(projectId);
  if (!plan) return "This pitch project no longer exists.";
  const included = plan.selections.filter((selection) => selection.status !== "REJECTED");
  if (/\bdepots?\b/i.test(question)) {
    const depots = [...new Set(included.map((selection) => selection.depot).filter((depot): depot is string => !!depot))].sort();
    return depots.length ? `Depots represented by this pitch's proposed and shortlisted routes: ${depots.join(", ")}. These are source depots, not confirmed bus allocations.` : "No bus routes with a source depot are currently proposed for this pitch.";
  }
  if (/\broutes?\b/i.test(question)) {
    return included.length
      ? `This pitch includes ${included.length} route source selections:\n${included.map((selection) => `Route ${selection.routeId} (${selection.depot ?? "depot not supplied"}, ${selection.sourceSheet.trim()} row ${selection.sourceRow}): ${selection.proposedQuantity} proposed buses; source buses: ${selection.sourceBusCount ?? "not supplied"}; ${selection.status.toLowerCase()}`).join("\n")}\nThese quantities are proposals, not reservations.`
      : "No bus routes are proposed or shortlisted in this pitch yet.";
  }
  return `This pitch currently proposes ${plan.totalProposedBuses} buses across ${included.length} route source selections. Rejected selections are excluded. These buses are not reserved or confirmed.`;
}