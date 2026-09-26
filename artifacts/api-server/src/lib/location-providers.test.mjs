import assert from "node:assert/strict";
import test from "node:test";
import { createNominatimLocationProvider } from "./location-providers.ts";

function response(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  };
}

function osmResult(overrides = {}) {
  return {
    osm_type: "node",
    osm_id: 123,
    lat: "25.1972",
    lon: "55.2744",
    name: "Burj Khalifa",
    display_name: "Burj Khalifa, Downtown Dubai, Dubai, United Arab Emirates",
    category: "tourism",
    type: "attraction",
    address: { suburb: "Downtown Dubai", city: "Dubai" },
    ...overrides,
  };
}

test("Nominatim searches exact user queries, has a small limit, and caches for 24 hours", async () => {
  const requests = [];
  let now = 1_000;
  const provider = createNominatimLocationProvider({
    minimumRequestIntervalMs: 0,
    now: () => now,
    fetchImpl: async (url, options) => {
      requests.push({ url: new URL(url), options });
      return response([osmResult()]);
    },
  });

  const first = await provider.search("Burj Khalifa", 99);
  now += 23 * 60 * 60 * 1000;
  const cached = await provider.search("Burj Khalifa", 99);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url.searchParams.get("q"), "Burj Khalifa");
  assert.equal(requests[0].url.searchParams.get("limit"), "10");
  assert.match(requests[0].options.headers["User-Agent"], /Pitch Intelligence Workspace/);
  assert.doesNotMatch(requests[0].options.headers["User-Agent"], /openstreetmap/i);
  assert.deepEqual(cached, first);
  assert.equal(first[0].confidence, "LIKELY");
  assert.equal(first[0].category, "attraction");
  assert.equal(first[0].sourceUrl, "https://www.openstreetmap.org/node/123");
  assert.equal(first[0].sourceReference, first[0].sourceUrl);
  assert.equal(first[0].area, "Downtown Dubai");
  assert.equal(first[0].locationType, "UNVERIFIED_CANDIDATE");
  assert.equal(first[0].evidenceType, "MAP_DIRECTORY");
  assert.equal(first[0].evidenceStatus, "NEEDS_SOURCE_VERIFICATION");
  assert.equal(first[0].evidence, first[0].address);

  now += 60 * 60 * 1000 + 1;
  await provider.search("Burj Khalifa", 99);
  assert.equal(requests.length, 2);
});

test("invalid coordinates and missing OSM element references are discarded; ambiguity is reviewed", async () => {
  const provider = createNominatimLocationProvider({
    minimumRequestIntervalMs: 0,
    fetchImpl: async () => response([
      osmResult({ osm_id: 124, name: "Central Park", display_name: "Central Park, Example" }),
      osmResult({ osm_type: "way", osm_id: 456, name: "Central Park Annex", display_name: "Central Park Annex, Example" }),
      osmResult({ osm_id: 457, lat: "", name: "Bad coordinates" }),
      osmResult({ osm_type: "unknown", osm_id: 458, name: "Bad reference" }),
    ]),
  });

  const results = await provider.search("Central Park");
  assert.equal(results.length, 2);
  assert.ok(results.every((result) => result.confidence === "NEEDS_REVIEW"));
  assert.equal(results[1].sourceUrl, "https://www.openstreetmap.org/way/456");
  assert.ok(results.every((result) => result.confidence !== "VERIFIED"));
});

test("UAE-specific queries exclude results outside the UAE bounding area", async () => {
  const provider = createNominatimLocationProvider({
    minimumRequestIntervalMs: 0,
    fetchImpl: async () => response([
      osmResult({ osm_id: 201 }),
      osmResult({
        osm_id: 202,
        lat: "51.5072",
        lon: "-0.1276",
        name: "Dubai",
        display_name: "Dubai, London, United Kingdom",
      }),
    ]),
  });

  const results = await provider.search("Dubai");
  assert.equal(results.length, 1);
  assert.equal(results[0].sourceUrl, "https://www.openstreetmap.org/node/201");
});

test("HTTP 429 and 503 failures are explicit and are not cached as empty results", async () => {
  for (const status of [429, 503]) {
    let requests = 0;
    const provider = createNominatimLocationProvider({
      minimumRequestIntervalMs: 0,
      fetchImpl: async () => {
        requests += 1;
        return response([], status);
      },
    });
    await assert.rejects(provider.search(`rate limit ${status}`), new RegExp(`HTTP ${status}`));
    await assert.rejects(provider.search(`rate limit ${status}`), new RegExp(`HTTP ${status}`));
    assert.equal(requests, 2);
  }
});

test("empty searches do not call the service and invalid query types are rejected", async () => {
  let requests = 0;
  const provider = createNominatimLocationProvider({
    minimumRequestIntervalMs: 0,
    fetchImpl: async () => {
      requests += 1;
      return response([]);
    },
  });
  assert.deepEqual(await provider.search("  "), []);
  await assert.rejects(provider.search(4), /must be a string/);
  assert.equal(requests, 0);
});

test("specific Nominatim feature type takes precedence over broad class", async () => {
  const provider = createNominatimLocationProvider({
    minimumRequestIntervalMs: 0,
    fetchImpl: async () => response([osmResult({
      category: "shop",
      type: "supermarket",
      name: "Fresh Market",
      display_name: "Fresh Market, Dubai, United Arab Emirates",
    })]),
  });
  const [location] = await provider.search("Fresh Market");
  assert.equal(location.category, "supermarket");
});

test("a timed-out upstream request releases the queue for subsequent searches", async () => {
  let requestCount = 0;
  const requestedTimeouts = [];
  const provider = createNominatimLocationProvider({
    minimumRequestIntervalMs: 0,
    upstreamTimeoutMs: 5,
    timeoutSignal: (milliseconds) => {
      requestedTimeouts.push(milliseconds);
      const controller = new AbortController();
      setTimeout(() => {
        controller.abort(new DOMException("The operation timed out", "TimeoutError"));
      }, milliseconds);
      return controller.signal;
    },
    fetchImpl: async (_url, { signal }) => {
      requestCount += 1;
      if (requestCount === 1) {
        return new Promise((resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }
      return response([]);
    },
  });

  await assert.rejects(provider.search("hung upstream query"), /timed out/i);
  assert.deepEqual(await provider.search("queue continues after timeout"), []);
  assert.equal(requestCount, 2);
  assert.deepEqual(requestedTimeouts, [5, 5]);
});