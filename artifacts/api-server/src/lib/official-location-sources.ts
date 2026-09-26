import { spawn } from "node:child_process";

export type LocationType =
  | "BRAND_STORE"
  | "AUTHORIZED_RETAILER"
  | "DEALER_DISTRIBUTOR"
  | "CAMPAIGN_ACTIVATION_LOCATION"
  | "EXHIBITION_VENUE"
  | "UNVERIFIED_CANDIDATE";

export type LocationEvidenceType =
  | "HISENSE_OFFICIAL_STORE_LOCATOR"
  | "HISENSE_OFFICIAL_CAMPAIGN_PAGE"
  | "HISENSE_OFFICIAL_TERMS_PDF"
  | "HISENSE_OFFICIAL_RETAILER_LIST"
  | "HISENSE_OFFICIAL_NEWSROOM"
  | "OFFICIAL_MALL_DIRECTORY"
  | "MAP_DIRECTORY"
  | "USER_PROVIDED"
  | "OTHER";

export type LocationEvidenceStatus =
  | "OFFICIAL_SOURCE_VERIFIED"
  | "OFFICIAL_TEXT_COORDINATES_UNVERIFIED"
  | "NEEDS_SOURCE_VERIFICATION"
  | "USER_PROVIDED";

export interface OfficialLocationCandidate {
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
  confidence: "LIKELY" | "NEEDS_REVIEW";
  locationType: LocationType;
  evidenceType: LocationEvidenceType;
  evidenceStatus: LocationEvidenceStatus;
  sourceDate: string | null;
  coordinatesSourceUrl: string | null;
}

const MAX_HTML_BYTES = 1_000_000;
const MAX_PDF_BYTES = 8_000_000;
const MAX_PDF_TEXT_CHARS = 200_000;
const FETCH_TIMEOUT_MS = 9_000;
const PDF_TIMEOUT_MS = 5_000;
const MAX_STORE_PAGES = 8;
const MAX_PDFS = 5;
const OFFICIAL_HOSTS = new Set([
  "hisenseme.com",
  "www.hisenseme.com",
  "shophisense.com",
  "www.shophisense.com",
  "dubaihillsmall.ae",
  "www.dubaihillsmall.ae",
  "reemmall.ae",
  "www.reemmall.ae",
]);
const OFFICIAL_INDEX_PAGES = [
  "https://www.shophisense.com/",
  "https://hisenseme.com/",
  "https://hisenseme.com/about-hisense/support/certificate",
  "https://hisenseme.com/about-hisense/newsroom",
  "https://www.shophisense.com/deals-promotions",
];
const TEXT_TERMS = /\b(?:terms|conditions|campaign|promotion|promotional|offers|retailer|deal)\b/i;
const KNOWN_UAE_AREAS = [
  "Dubai Hills Mall",
  "Mall of the Emirates",
  "City Centre Mirdif",
  "Mirdif City Centre",
  "MCC",
  "Times Square",
  "Times Square Center",
  "Times Square Centre",
  "Reem Mall",
];
const MAX_RELATED_SOURCE_PAGES = 12;
const HISENSE_SITEMAP_URL = "https://hisenseme.com/sitemap.xml";

interface DownloadedResource {
  url: string;
  contentType: string;
  bytes: Uint8Array;
}

function allowedOfficialUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !OFFICIAL_HOSTS.has(url.hostname.toLowerCase()) ||
      (url.port && url.port !== "443") || url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
}

async function fetchOfficialResource(
  initialUrl: string,
  maxBytes: number,
  fetchImpl: typeof fetch,
): Promise<DownloadedResource | null> {
  let url = allowedOfficialUrl(initialUrl);
  if (!url) return null;

  for (let redirectCount = 0; redirectCount <= 2; redirectCount += 1) {
    const response = await fetchImpl(url, {
      headers: { Accept: "text/html,application/pdf;q=0.9,*/*;q=0.1" },
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (response.status >= 300 && response.status < 400) {
      const redirect = response.headers.get("location");
      if (!redirect || redirectCount === 2) return null;
      const next = allowedOfficialUrl(new URL(redirect, url).toString());
      if (!next) return null;
      url = next;
      continue;
    }
    if (!response.ok) return null;
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > maxBytes) return null;
    const reader = response.body?.getReader();
    if (!reader) return null;
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > maxBytes) {
          await reader.cancel();
          return null;
        }
        chunks.push(chunk.value);
      }
    } finally {
      reader.releaseLock();
    }
    const content = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      content.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return {
      url: url.toString(),
      contentType: response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "",
      bytes: content,
    };
  }
  return null;
}

function decodeHtml(value: string): string {
  return value
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#x([0-9a-f]+);/gi, (_whole, digits: string) => String.fromCodePoint(Number.parseInt(digits, 16)))
    .replace(/&#([0-9]+);/g, (_whole, digits: string) => String.fromCodePoint(Number.parseInt(digits, 10)));
}

function htmlText(html: string): string {
  return decodeHtml(html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, " ")
    .replace(/<(?:br|\/p|\/div|\/li|\/h[1-6]|\/section|\/article)\b[^>]*>/gi, "\n")
    .replace(/<[^>]*>/g, " "))
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 100_000);
}

function linksFromHtml(html: string, baseUrl: string): Array<{ url: string; label: string }> {
  const links: Array<{ url: string; label: string }> = [];
  const anchorPattern = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a\s*>/gi;
  for (const match of html.matchAll(anchorPattern)) {
    try {
      const url = allowedOfficialUrl(new URL(decodeHtml(match[1]!), baseUrl).toString());
      if (!url) continue;
      url.hash = "";
      if (url.pathname.startsWith("/where-to-buy/")) url.search = "";
      links.push({ url: url.toString(), label: htmlText(match[2]!).slice(0, 300) });
    } catch {
      // Ignore malformed and non-HTTPS links from the source page.
    }
  }
  return links;
}

async function newsroomPagesFromSitemap(fetchImpl: typeof fetch): Promise<Array<{ url: string; label: string }>> {
  const resource = await fetchOfficialResource(HISENSE_SITEMAP_URL, MAX_HTML_BYTES, fetchImpl);
  if (!resource || !/xml|text/i.test(resource.contentType)) return [];
  const xml = new TextDecoder().decode(resource.bytes);
  return [...xml.matchAll(/<loc>([\s\S]*?)<\/loc>/gi)]
    .map((match) => allowedOfficialUrl(decodeHtml(match[1]!.trim()))?.toString() ?? null)
    .filter((url): url is string => !!url)
    .filter((url) => {
      const path = new URL(url).pathname;
      return /\/about-hisense\/newsroom-details\//i.test(path) &&
        /\b(?:campaign|promotion|offers|retail|store|event|uae|arena|mall|showroom)\b/i.test(path);
    })
    .sort((a, b) => {
      const priority = (url: string) => /\b(?:campaign|promotion|retail|store|arena|mall|activation)\b/i.test(url) ? 0 : 1;
      return priority(a) - priority(b) || a.localeCompare(b);
    })
    .slice(0, MAX_RELATED_SOURCE_PAGES)
    .map((url) => ({ url, label: "Hisense newsroom source" }));
}

function sourceDateFromHtml(html: string): string | null {
  const values = [
    ...html.matchAll(/<time\b[^>]*datetime=["'](\d{4}-\d{2}-\d{2})(?:T[^"']*)?["']/gi),
    ...html.matchAll(/<meta\b[^>]*(?:property|name)=["'](?:article:published_time|datePublished|date)["'][^>]*content=["'](\d{4}-\d{2}-\d{2})/gi),
  ].map((match) => match[1]!);
  return values.find((value) => /^\d{4}-\d{2}-\d{2}$/.test(value)) ?? null;
}

function sourceDateFromTermsText(text: string): string | null {
  const labeledDate = text.match(/\b(?:published|publication date|issued|issue date|last updated|effective date)\b[^\n]{0,40}?\b(\d{4}-\d{2}-\d{2})\b/i);
  if (!labeledDate?.[1]) return null;
  const date = new Date(`${labeledDate[1]}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== labeledDate[1]
    ? null
    : labeledDate[1];
}

function coordinatesFromLinks(html: string, baseUrl: string): {
  latitude: number | null;
  longitude: number | null;
  coordinatesSourceUrl: string | null;
} {
  const links = html.matchAll(/href=["']([^"']*(?:google\.[^"' ]+\/maps|maps\.google\.[^"' ]+)[^"']*)["']/gi);
  for (const match of links) {
    try {
      const link = new URL(decodeHtml(match[1]!), baseUrl);
      const destination = link.searchParams.get("destination") ??
        link.searchParams.get("query") ??
        link.searchParams.get("q");
      const coordinates = destination?.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
      if (!coordinates) continue;
      const latitude = Number(coordinates[1]);
      const longitude = Number(coordinates[2]);
      if (!Number.isFinite(latitude) || latitude < 22.5 || latitude > 26.5 ||
        !Number.isFinite(longitude) || longitude < 51.5 || longitude > 56.5) continue;
      return { latitude, longitude, coordinatesSourceUrl: link.toString() };
    } catch {
      // Ignore invalid map links.
    }
  }
  return { latitude: null, longitude: null, coordinatesSourceUrl: null };
}

function decodeSlug(url: string): string {
  const slug = new URL(url).pathname.split("/").filter(Boolean).at(-1) ?? "Hisense Store";
  return slug.replace(/[-_]+/g, " ").replace(/\b\p{L}/gu, (letter) => letter.toLocaleUpperCase());
}

function lineExcerpt(text: string, index: number, radius = 170): string {
  const start = Math.max(0, text.lastIndexOf("\n", index) + 1, text.lastIndexOf(".", index) + 1);
  const newline = text.indexOf("\n", index);
  const period = text.indexOf(".", index);
  const possibleEnds = [newline, period < 0 ? -1 : period + 1].filter((end) => end >= index);
  const end = possibleEnds.length ? Math.min(...possibleEnds) : Math.min(text.length, index + radius);
  return text.slice(Math.max(start, index - radius), Math.min(end, index + radius)).replace(/\s+/g, " ").trim();
}

function parseHisenseLocationMentions(
  text: string,
  sourceUrl: string,
  sourceDate: string | null,
  evidenceType: Extract<LocationEvidenceType, "HISENSE_OFFICIAL_TERMS_PDF" | "HISENSE_OFFICIAL_CAMPAIGN_PAGE" | "HISENSE_OFFICIAL_RETAILER_LIST" | "HISENSE_OFFICIAL_NEWSROOM">,
): OfficialLocationCandidate[] {
  const allowedSource = allowedOfficialUrl(sourceUrl);
  if (!allowedSource) return [];
  const verifiedSourceDate = sourceDate ?? sourceDateFromTermsText(text);
  const normalized = text.replace(/\s+/g, " ").trim();
  const matches: OfficialLocationCandidate[] = [];
  const seen = new Set<string>();
  for (const place of KNOWN_UAE_AREAS) {
    const match = new RegExp(`\\b${place.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").exec(normalized);
    if (!match) continue;
    const matchedText = match[0]!.toLocaleLowerCase();
    if (KNOWN_UAE_AREAS.some((otherPlace) => {
      const otherText = otherPlace.toLocaleLowerCase();
      return otherText.length > matchedText.length &&
        normalized.slice(match.index, match.index + otherText.length).toLocaleLowerCase() === otherText;
    })) continue;
    const excerpt = lineExcerpt(normalized, match.index, 210);
    const escapedPlace = place.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const retailerEvidence = new RegExp(
      `(?:\\b(?:authorized|authorised|participating)\\s+(?:retailer|store|outlet)s?\\b[^.]{0,90}${escapedPlace}|${escapedPlace}[^.]{0,90}\\b(?:authorized|authorised|participating)\\s+(?:retailer|store|outlet)s?\\b)`,
      "i",
    ).test(excerpt);
    const dealerDistributorEvidence = new RegExp(
      `(?:\\b(?:(?:authorized|authorised|official)\\s+)?(?:dealer|distributor)s?\\b[^.]{0,90}${escapedPlace}|${escapedPlace}[^.]{0,90}\\b(?:(?:authorized|authorised|official)\\s+)?(?:dealer|distributor)s?\\b)`,
      "i",
    ).test(excerpt);
    const campaignEvidence = new RegExp(
      `(?:\\b(?:campaign|promotion|event|activation|exhibition|expo|showroom|arena|pop-up|popup)\\b[^.]{0,90}${escapedPlace}|${escapedPlace}[^.]{0,90}\\b(?:campaign|promotion|event|activation|exhibition|expo|showroom|arena|pop-up|popup)\\b)`,
      "i",
    ).test(excerpt);
    // A venue name by itself (or a general retailer list) is not evidence that
    // Hisense uses that individual branch or venue.
    if (!/\bhisense\b/i.test(excerpt) ||
      (!dealerDistributorEvidence && !retailerEvidence && !campaignEvidence)) continue;
    const key = place.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const locationType: LocationType = dealerDistributorEvidence
      ? "DEALER_DISTRIBUTOR"
      : retailerEvidence
        ? "AUTHORIZED_RETAILER"
        : /\b(?:exhibition|expo|showroom|arena)\b/i.test(excerpt)
        ? "EXHIBITION_VENUE"
        : "CAMPAIGN_ACTIVATION_LOCATION";
    matches.push({
      providerId: "hisense-official-terms",
      name: `Hisense location candidate — ${place}`,
      category: locationType === "DEALER_DISTRIBUTOR"
        ? "Hisense dealer or distributor"
        : locationType === "AUTHORIZED_RETAILER" ? "Hisense retailer" : "Hisense location candidate",
      address: place,
      latitude: null,
      longitude: null,
      area: place.includes("Dubai") || place.includes("Mirdif") ? "Dubai" : null,
      sourceUrl: allowedSource.toString(),
      sourceReference: `${allowedSource}#${key.replace(/\s+/g, "-")}`,
      evidence: excerpt,
      confidence: "NEEDS_REVIEW",
      locationType,
      evidenceType,
      evidenceStatus: "OFFICIAL_TEXT_COORDINATES_UNVERIFIED",
      sourceDate: verifiedSourceDate,
      coordinatesSourceUrl: null,
    });
  }
  return matches;
}

export function parseHisenseTermsLocationMentions(
  text: string,
  sourceUrl: string,
  sourceDate: string | null,
): OfficialLocationCandidate[] {
  return parseHisenseLocationMentions(text, sourceUrl, sourceDate, "HISENSE_OFFICIAL_TERMS_PDF");
}

function campaignEvidenceType(url: string): Extract<
  LocationEvidenceType,
  "HISENSE_OFFICIAL_CAMPAIGN_PAGE" | "HISENSE_OFFICIAL_RETAILER_LIST" | "HISENSE_OFFICIAL_NEWSROOM"
> {
  const path = new URL(url).pathname.toLowerCase();
  if (/\/about-hisense\/newsroom-details\//.test(path)) return "HISENSE_OFFICIAL_NEWSROOM";
  if (/retail|dealer|where-to-buy/.test(path)) return "HISENSE_OFFICIAL_RETAILER_LIST";
  return "HISENSE_OFFICIAL_CAMPAIGN_PAGE";
}

function campaignCandidatesFromPages(pages: Array<{
  url: string;
  text: string;
  html: string;
}>): OfficialLocationCandidate[] {
  return pages.flatMap((page) => parseHisenseLocationMentions(
    page.text,
    page.url,
    sourceDateFromHtml(page.html),
    campaignEvidenceType(page.url),
  ));
}

function extractPdfText(bytes: Uint8Array): Promise<string> {
  if (bytes.byteLength > MAX_PDF_BYTES) {
    return Promise.reject(new Error("An official Terms PDF exceeds the safe extraction size limit."));
  }
  if (new TextDecoder().decode(bytes.slice(0, 5)) !== "%PDF-") {
    return Promise.reject(new Error("An official Terms PDF did not contain a valid PDF document."));
  }
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn("pdftotext", ["-layout", "-", "-"], { stdio: ["pipe", "pipe", "ignore"] });
    } catch {
      reject(new Error("Official Terms PDFs could not be read: pdftotext is unavailable."));
      return;
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    let exceededTextLimit = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, PDF_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Uint8Array) => {
      size += chunk.byteLength;
      if (size > MAX_PDF_TEXT_CHARS) {
        exceededTextLimit = true;
        child.kill("SIGKILL");
        return;
      }
      chunks.push(chunk);
    });
    child.once("error", () => {
      clearTimeout(timer);
      reject(new Error("Official Terms PDFs could not be read: pdftotext is unavailable."));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (exceededTextLimit) {
        reject(new Error("Official Terms PDF text exceeds the safe extraction limit."));
        return;
      }
      if (timedOut) {
        reject(new Error("Official Terms PDF text extraction timed out."));
        return;
      }
      if (code !== 0) {
        reject(new Error("Official Terms PDF text extraction failed."));
        return;
      }
      const text = new TextDecoder().decode(Buffer.concat(chunks));
      resolve(text.slice(0, MAX_PDF_TEXT_CHARS));
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(Buffer.from(bytes));
  });
}

async function termsCandidatesFromPages(pages: Array<{
  url: string;
  html: string;
  text: string;
}>, fetchImpl: typeof fetch, pdfTextExtractor: (bytes: Uint8Array) => Promise<string>): Promise<OfficialLocationCandidate[]> {
  const documentLinks = pages.flatMap((page) => linksFromHtml(page.html, page.url)
    .map((link) => ({ ...link, landingPageDate: sourceDateFromHtml(page.html) })))
    .filter(({ url, label }) => /\.pdf(?:$|[?#])/i.test(url) && TEXT_TERMS.test(`${url} ${label}`))
    .filter(({ url }) => allowedOfficialUrl(url) !== null)
    .slice(0, MAX_PDFS);
  const results = await Promise.all(documentLinks.map(async ({ url, landingPageDate }) => {
    const resource = await fetchOfficialResource(url, MAX_PDF_BYTES, fetchImpl);
    if (!resource || (!resource.contentType.includes("pdf") && !/\.pdf(?:$|[?#])/i.test(resource.url))) return [];
    const text = await pdfTextExtractor(resource.bytes);
    return parseHisenseTermsLocationMentions(text, resource.url, landingPageDate);
  }));
  return results.flat();
}

/**
 * Discover Hisense UAE candidates from its own store-locator pages and official
 * campaign/T&C links. All candidates remain unapproved; retail branches are
 * emitted only when a source identifies the specific location.
 */
export async function discoverHisenseOfficialLocations(
  query: string,
  options: {
    fetchImpl?: typeof fetch;
    pdfTextExtractor?: (bytes: Uint8Array) => Promise<string>;
  } = {},
): Promise<OfficialLocationCandidate[]> {
  const normalizedQuery = query.toLocaleLowerCase();
  if (!normalizedQuery.includes("hisense")) return [];
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const pdfTextExtractor = options.pdfTextExtractor ?? extractPdfText;
  const pages = (await Promise.all(OFFICIAL_INDEX_PAGES.map(async (url) => {
    const resource = await fetchOfficialResource(url, MAX_HTML_BYTES, fetchImpl);
    if (!resource || !resource.contentType.includes("html")) return null;
    const html = new TextDecoder().decode(resource.bytes);
    return { url: resource.url, html, text: htmlText(html) };
  }))).filter(
    (page): page is NonNullable<typeof page> => !!page,
  );
  const sitemapPages = await newsroomPagesFromSitemap(fetchImpl);
  const relatedPageLinks = [...pages.flatMap((page) => linksFromHtml(page.html, page.url)), ...sitemapPages]
    .filter(({ url, label }) => {
      const path = new URL(url).pathname.toLowerCase();
      return (
        /\/about-hisense\/newsroom-details\//.test(path) &&
        /\b(?:campaign|promotion|offers|retail|store|event|uae)\b/i.test(`${path} ${label}`)
      ) ||
        /\/(?:where-to-buy|latest-promotions|deals[-_]promotions|fifaworldcup|ownthemomenthub)/i.test(path);
    })
    .filter(({ url }, index, links) => links.findIndex((link) => link.url === url) === index)
    .slice(0, MAX_RELATED_SOURCE_PAGES);
  const relatedPages = (await Promise.all(relatedPageLinks.map(async ({ url }) => {
    const resource = await fetchOfficialResource(url, MAX_HTML_BYTES, fetchImpl);
    if (!resource || !resource.contentType.includes("html")) return null;
    const html = new TextDecoder().decode(resource.bytes);
    return { url: resource.url, html, text: htmlText(html) };
  }))).filter((page): page is NonNullable<typeof page> => !!page);
  const sourcePages = [...pages, ...relatedPages];
  const storePages = sourcePages.flatMap((page) => linksFromHtml(page.html, page.url))
    .filter(({ url }) => {
      const parsed = new URL(url);
      return parsed.hostname.toLowerCase().endsWith("shophisense.com") &&
        parsed.pathname.startsWith("/where-to-buy/");
    })
    .filter(({ url }, index, links) => links.findIndex((link) => link.url === url) === index)
    .slice(0, MAX_STORE_PAGES);
  const storeResults = await Promise.all(storePages.map(async ({ url }): Promise<OfficialLocationCandidate | null> => {
    const resource = await fetchOfficialResource(url, MAX_HTML_BYTES, fetchImpl);
    if (!resource || !resource.contentType.includes("html")) return null;
    const html = new TextDecoder().decode(resource.bytes);
    const page = { url: resource.url, html, text: htmlText(html) };
    if (!/\bhisense\b/i.test(page.text) || !/where-to-buy/i.test(new URL(page.url).pathname)) return null;
    const addressMatch = page.text.match(/\b(?:FF|L\d{1,2}|Floor\s+\d+)\s*,?\s*Shop\s*[#＃]?\s*[\d０-９]+[^.\n]{0,130}/i);
    const address = addressMatch?.[0]?.trim() ?? null;
    const heading = decodeSlug(page.url);
    const coordinates = coordinatesFromLinks(page.html, page.url);
    const excerpt = address ?? heading;
    return {
      providerId: "hisense-official-store-locator",
      name: `Hisense Brand Store — ${heading}`,
      category: "Hisense brand store",
      address,
      latitude: coordinates.latitude,
      longitude: coordinates.longitude,
      area: /abu dhabi/i.test(`${heading} ${address}`) ? "Abu Dhabi" : "Dubai",
      sourceUrl: page.url,
      sourceReference: page.url,
      evidence: excerpt,
      confidence: address && coordinates.latitude !== null ? "LIKELY" as const : "NEEDS_REVIEW" as const,
      locationType: "BRAND_STORE" as const,
      evidenceType: "HISENSE_OFFICIAL_STORE_LOCATOR" as const,
      evidenceStatus: address && coordinates.latitude !== null
        ? "OFFICIAL_SOURCE_VERIFIED" as const
        : "OFFICIAL_TEXT_COORDINATES_UNVERIFIED" as const,
      sourceDate: sourceDateFromHtml(page.html),
      coordinatesSourceUrl: coordinates.coordinatesSourceUrl,
    } satisfies OfficialLocationCandidate;
  }));
  const termsCandidates = await termsCandidatesFromPages(sourcePages, fetchImpl, pdfTextExtractor);
  const campaignCandidates = campaignCandidatesFromPages(relatedPages);
  const combined = [
    ...storeResults.filter((candidate): candidate is OfficialLocationCandidate => candidate !== null),
    ...campaignCandidates,
    ...termsCandidates,
  ];
  const unique = new Map(combined.map((candidate) => [candidate.sourceReference, candidate]));
  return [...unique.values()];
}