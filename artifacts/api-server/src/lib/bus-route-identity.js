function normalizedHeader(value) {
  return value.toLocaleLowerCase().replace(/[^a-z0-9]/g, "");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function identityText(rawData, ...headers) {
  const wanted = new Set(headers.map(normalizedHeader));
  const entry = Object.entries(rawData).find(([header]) => wanted.has(normalizedHeader(header)));
  return entry?.[1] == null ? "" : String(entry[1]).trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

export function busRouteStructuralIdentity(sheetName, rawData, routeId) {
  return stableJson([
    sheetName,
    routeId.trim().replace(/\s+/g, " ").toLocaleLowerCase(),
    identityText(rawData, "Starting Station", "Start Station", "From"),
    identityText(rawData, "Ending station", "Ending Station", "End Station", "To"),
    identityText(rawData, "Via"),
    identityText(rawData, "Depot Name", "Depot"),
    identityText(rawData, "Bus Type", "Vehicle Type"),
  ]);
}