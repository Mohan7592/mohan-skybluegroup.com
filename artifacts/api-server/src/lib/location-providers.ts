import type {
  LocationEvidenceStatus,
  LocationEvidenceType,
  LocationType,
} from "./official-location-sources";

export type LocationConfidence = "LIKELY" | "NEEDS_REVIEW";

export interface ProviderLocation {
  providerId: string;
  name: string;
  category: string;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  area: string | null;
  sourceUrl: string;
  sourceReference: string;
  evidence: string;
  confidence: LocationConfidence;
  locationType: LocationType;
  evidenceType: LocationEvidenceType;
  evidenceStatus: LocationEvidenceStatus;
  sourceDate: string | null;
  coordinatesSourceUrl: string | null;
}

export interface LocationSearchProvider {
  search(query: string, limit?: number): Promise<ProviderLocation[]>;
}

export interface GeocodingProvider {
  geocode(query: string, limit?: number): Promise<ProviderLocation[]>;
}

export interface POIProvider {
  searchPois(query: string, limit?: number): Promise<ProviderLocation[]>;
}

const NOMINATIM_ENDPOINT = "https://nominatim.openstreetmap.org/search";
const NOMINATIM_USER_AGENT =
  "Pitch Intelligence Workspace/1.0 (interactive location search)";
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 10;
const REQUEST_INTERVAL_MS = 1000;
const UPSTREAM_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const PROVIDER_ID = "openstreetmap-nominatim";

type NominatimResult = {
  osm_type?: unknown;
  osm_id?: unknown;
  lat?: unknown;
  lon?: unknown;
  name?: unknown;
  display_name?: unknown;
  category?: unknown;
  type?: unknown;
  address?: unknown;
};

export interface NominatimProviderOptions {
  /** Injectable transport and timing make provider behavior unit-testable. */
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  minimumRequestIntervalMs?: number;
  cacheTtlMs?: number;
  upstreamTimeoutMs?: number;
  timeoutSignal?: (milliseconds: number) => AbortSignal;
}

const cache = new Map<string, { expiresAt: number; locations: ProviderLocation[] }>();
const inFlight = new Map<string, Promise<ProviderLocation[]>>();
let requestQueue: Promise<void> = Promise.resolve();
let lastRequestStartedAt = Number.NEGATIVE_INFINITY;

function scheduleRequest<T>(
  operation: () => Promise<T>,
  now: () => number,
  sleep: (milliseconds: number) => Promise<void>,
  minimumIntervalMs: number,
): Promise<T> {
  const scheduled = requestQueue.then(async () => {
    const waitMs = minimumIntervalMs - (now() - lastRequestStartedAt);
    if (waitMs > 0) await sleep(waitMs);
    lastRequestStartedAt = now();
    return operation();
  });
  requestQueue = scheduled.then(() => undefined, () => undefined);
  return scheduled;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function validCoordinates(latitude: unknown, longitude: unknown): [number, number] | null {
  if ((typeof latitude !== "number" && typeof latitude !== "string") ||
      (typeof longitude !== "number" && typeof longitude !== "string") ||
      (typeof latitude === "string" && !latitude.trim()) ||
      (typeof longitude === "string" && !longitude.trim())) return null;
  const lat = typeof latitude === "number" ? latitude : Number(latitude);
  const lon = typeof longitude === "number" ? longitude : Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) ||
      lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return [lat, lon];
}

function osmElementUrl(result: NominatimResult): string | null {
  const type = typeof result.osm_type === "string" ? result.osm_type.toLowerCase() : "";
  const elementType = ({ n: "node", w: "way", r: "relation" } as Record<string, string>)[type] ?? type;
  const id = typeof result.osm_id === "number" ? result.osm_id : Number(result.osm_id);
  if (!["node", "way", "relation"].includes(elementType) || !Number.isSafeInteger(id) || id <= 0) {
    return null;
  }
  return `https://www.openstreetmap.org/${elementType}/${id}`;
}

function areaFromAddress(address: unknown): string | null {
  if (address == null || typeof address !== "object" || Array.isArray(address)) return null;
  const parts = address as Record<string, unknown>;
  for (const key of ["suburb", "neighbourhood", "city_district", "city", "town", "village", "county", "state"]) {
    const value = stringValue(parts[key]);
    if (value) return value;
  }
  return null;
}

function isUaeSpecificQuery(query: string): boolean {
  return /\b(?:uae|united arab emirates|dubai|abu dhabi|sharjah|ajman|fujairah|ras al khaimah|umm al quwain)\b/i
    .test(query);
}

function isWithinUae(latitude: number, longitude: number): boolean {
  // A deliberately broad UAE bounding box; this only narrows queries that name the UAE or an emirate.
  return latitude >= 22.5 && latitude <= 26.5 && longitude >= 51.5 && longitude <= 56.5;
}

function parseResults(
  results: unknown,
  query: string,
): ProviderLocation[] {
  if (!Array.isArray(results)) throw new Error("Nominatim returned an invalid response.");
  const candidates: Omit<ProviderLocation, "confidence">[] = [];
  for (const value of results) {
    if (value == null || typeof value !== "object" || Array.isArray(value)) continue;
    const result = value as NominatimResult;
    const coordinates = validCoordinates(result.lat, result.lon);
    const sourceUrl = osmElementUrl(result);
    if (!coordinates || !sourceUrl) continue;
    const [latitude, longitude] = coordinates;
    if (isUaeSpecificQuery(query) && !isWithinUae(latitude, longitude)) continue;

    const displayName = stringValue(result.display_name);
    const name = stringValue(result.name) ?? displayName?.split(",")[0]?.trim();
    if (!name || !displayName) continue;
    candidates.push({
      providerId: PROVIDER_ID,
      name,
      // Nominatim's `type` is the more specific feature (e.g. supermarket);
      // `category` is often a broader class (e.g. shop).
      category: stringValue(result.type) ?? stringValue(result.category) ?? "location",
      address: displayName,
      latitude,
      longitude,
      area: areaFromAddress(result.address),
      sourceUrl,
      sourceReference: sourceUrl,
      evidence: displayName,
      locationType: "UNVERIFIED_CANDIDATE",
      evidenceType: "MAP_DIRECTORY",
      evidenceStatus: "NEEDS_SOURCE_VERIFICATION",
      sourceDate: null,
      coordinatesSourceUrl: sourceUrl,
    });
  }

  const normalizedQuery = query.trim().toLocaleLowerCase();
  return candidates.map((candidate) => {
    const exactName = candidate.name.toLocaleLowerCase() === normalizedQuery ||
      (candidate.address !== null && (
        candidate.address.toLocaleLowerCase() === normalizedQuery ||
        candidate.address.toLocaleLowerCase().startsWith(`${normalizedQuery},`)
      ));
    return {
      ...candidate,
      // Multiple candidates or a non-exact match must be checked by the user.
      confidence: candidates.length === 1 && exactName ? "LIKELY" : "NEEDS_REVIEW",
    };
  });
}

/**
 * Create a Nominatim-backed search provider. Searches should be called only for
 * explicit user submissions (not autocomplete or background/bulk geocoding).
 */
export function createNominatimLocationProvider(
  options: NominatimProviderOptions = {},
): LocationSearchProvider & GeocodingProvider & POIProvider {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((milliseconds) =>
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const minimumIntervalMs = Math.max(0, options.minimumRequestIntervalMs ?? REQUEST_INTERVAL_MS);
  const cacheTtlMs = Math.max(0, options.cacheTtlMs ?? CACHE_TTL_MS);
  const upstreamTimeoutMs = Math.max(1, options.upstreamTimeoutMs ?? UPSTREAM_TIMEOUT_MS);
  const timeoutSignal = options.timeoutSignal ?? AbortSignal.timeout;

  async function search(query: string, limit = DEFAULT_LIMIT): Promise<ProviderLocation[]> {
    if (typeof query !== "string") throw new TypeError("Location query must be a string.");
    const exactQuery = query.trim();
    if (!exactQuery) return [];
    if (exactQuery.length > 256) throw new TypeError("Location query must be 256 characters or fewer.");
    const boundedLimit = Number.isFinite(limit)
      ? Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit)))
      : DEFAULT_LIMIT;
    const cacheKey = `${exactQuery}\u0000${boundedLimit}`;
    const cached = cache.get(cacheKey);
    if (cached && cached.expiresAt > now()) return cached.locations.map((location) => ({ ...location }));
    if (cached) cache.delete(cacheKey);
    const existingRequest = inFlight.get(cacheKey);
    if (existingRequest) return (await existingRequest).map((location) => ({ ...location }));

    const request = scheduleRequest(async () => {
      const url = new URL(NOMINATIM_ENDPOINT);
      url.searchParams.set("q", exactQuery);
      url.searchParams.set("format", "jsonv2");
      url.searchParams.set("addressdetails", "1");
      url.searchParams.set("limit", String(boundedLimit));
      const signal = timeoutSignal(upstreamTimeoutMs);
      const response = await fetchImpl(url, {
        signal,
        headers: {
          "User-Agent": NOMINATIM_USER_AGENT,
          Accept: "application/json",
        },
      });
      if (!response.ok) {
        throw new Error(`Nominatim location search failed with HTTP ${response.status}.`);
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new Error("Nominatim returned invalid JSON.");
      }
      const locations = parseResults(payload, exactQuery);
      cache.set(cacheKey, { expiresAt: now() + cacheTtlMs, locations });
      return locations;
    }, now, sleep, minimumIntervalMs);
    inFlight.set(cacheKey, request);
    try {
      return (await request).map((location) => ({ ...location }));
    } finally {
      inFlight.delete(cacheKey);
    }
  }

  return {
    search,
    geocode: search,
    searchPois: search,
  };
}

export const locationProvider = createNominatimLocationProvider();