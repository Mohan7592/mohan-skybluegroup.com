export type RouteAnswerVariant = {
  sheetName: string;
  sourceRowNumber: number;
  rawData: Record<string, unknown>;
};

export type RouteAnswerReference = {
  routeId: string;
  variants: RouteAnswerVariant[];
};

const text = (value: unknown) => typeof value === "string" ? value.trim()
  : typeof value === "number" ? String(value) : "";
const normalized = (value: string) => value.toLowerCase()
  .replace(/\bszr\b/g, "sheikh zayed road")
  .replace(/[^a-z0-9]+/g, " ").trim();

export function isBusRouteReferenceQuestion(question: string): boolean {
  const q = normalized(question);
  if (/\b(?:shelters?|inventory|assets?|panels?|mupis?|selected|shortlisted)\b/.test(q)) return false;
  if (/\b(?:show|list|which)\s+buses\b/.test(q)) return false;
  return /\broutes?\b/.test(q) && (
    /\b(?:show|which|list|details?|passing|pass|through|cover|covers|covering|depot|source|assign|how many|highest|largest)\b/.test(q)
  );
}

function passageTerms(question: string): string[] {
  const q = normalized(question);
  const match = q.match(/\b(?:passing|pass|passes|through|covering|cover|covers)\s+(.+)$/);
  return match ? match[1].split(/\s+and\s+/).map((value) => value.trim()).filter(Boolean) : [];
}

function routeFields(variant: RouteAnswerVariant) {
  const raw = variant.rawData;
  return {
    from: text(raw["Starting Station"]),
    to: text(raw["Ending station"]),
    via: text(raw["Via"]),
    full: text(raw["Full Routes"]),
    depot: text(raw["Depot Name"]),
    sourceBusCount: text(raw["Buses per Route"]),
  };
}

export function answerBusRouteQuestion(
  question: string,
  references: RouteAnswerReference[],
  contextRouteId?: string | null,
): string | null {
  if (!isBusRouteReferenceQuestion(question)) return null;
  if (!references.length) {
    return "No bus route reference has been synced yet. This sheet does not provide physical bus inventory.";
  }
  const q = normalized(question);
  const explicitId = q.match(/\broute\s+([a-z0-9-]+)\b/)?.[1];
  const routeId = explicitId && !["details", "passing", "through"].includes(explicitId)
    ? explicitId : contextRouteId;
  const depot = q.match(/\b(?:belong to|in|from|at)\s+(.+?)\s+depot\b/)?.[1] ?? null;
  const passages = passageTerms(question);
  const wantsCount = /\b(?:how many buses|bus count|buses per route|source assign)\b/.test(q);
  const rankByCount = /\b(?:highest|largest|most)\b/.test(q) && /\b(?:bus|buses)\b/.test(q);
  if (/\bthis route\b/.test(q) && !routeId) {
    return "Which Route ID do you mean? The source has route-level bus counts, not physical vehicle IDs.";
  }
  const matching = references.map((route) => ({
    ...route,
    variants: route.variants.filter((variant) => {
      const fields = routeFields(variant);
      if (depot && !normalized(fields.depot).includes(depot)) return false;
      const locations = normalized([fields.from, fields.to, fields.via, fields.full].join(" "));
      if (passages.some((passage) => !locations.includes(passage))) return false;
      return true;
    }),
  })).filter((route) => (!routeId || normalized(route.routeId) === normalized(routeId)) && route.variants.length);
  if (rankByCount) matching.sort((a, b) =>
    Math.max(...b.variants.map((v) => Number(routeFields(v).sourceBusCount) || 0)) -
    Math.max(...a.variants.map((v) => Number(routeFields(v).sourceBusCount) || 0)));
  if (!matching.length) {
    return `No synced bus route references matched ${routeId ? `Route ${routeId.toUpperCase()}` : depot ? `${depot} depot` : passages.join(" and ") || "that search"}. Route references are not physical bus inventory.`;
  }
  const labels = matching.slice(0, 20).map((route) => {
    const variants = route.variants.slice(0, 8).map((variant) => {
      const fields = routeFields(variant);
      const count = fields.sourceBusCount
        ? `source buses per route: ${fields.sourceBusCount}` : "source bus count not supplied";
      return `  • ${fields.from || "From unknown"} → ${fields.to || "To unknown"}${fields.via ? ` via ${fields.via}` : ""}; ${fields.depot || "depot unknown"}; ${count} (${variant.sheetName.trim()}, row ${variant.sourceRowNumber})`;
    });
    return `Route ${route.routeId}:\n${variants.join("\n")}${route.variants.length > 8 ? `\n  …and ${route.variants.length - 8} more source rows.` : ""}`;
  });
  const note = wantsCount || rankByCount
    ? "Bus counts are quoted per source row. Repeated Route IDs can represent different depots or variants; the counts are not a count of identifiable vehicles."
    : "These are route references, not identified physical buses.";
  return `Synced bus routes matching the question (${matching.length} distinct Route IDs):\n${labels.join("\n")}${matching.length > 20 ? `\n…and ${matching.length - 20} more. Narrow the route search to see them.` : ""}\n${note} Physical bus inventory still needs a vehicle-level source with Body Number or another stable ID.`;
}