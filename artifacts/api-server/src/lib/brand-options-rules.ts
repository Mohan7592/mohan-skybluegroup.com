import type { FetchedSource } from "./live-research";
import type { BrandOptionSelection } from "./brand-selection-token";

export type BrandOptionExtraction = {
  kind: BrandOptionSelection["kind"];
  name: string;
  parent: string | null;
  category: string | null;
  sourceUrl: string;
  evidenceQuote: string;
  parentEvidenceUrl: string | null;
  parentEvidenceQuote: string | null;
  categoryEvidenceQuote: string | null;
};
export type BrandOptionValidationCounts = {
  extractedOptions: number;
  validatedCompanies: number;
  validatedBrands: number;
  validatedCategories: number;
  standaloneTitleBrands: number;
  rejectedCompanyEvidence: number;
  rejectedOptionNameEvidence: number;
  rejectedParentEvidence: number;
  unsupportedCategories: number;
  rejectedCompanyIdentity: number;
  rejectedCompanyProductPage: number;
};

const multiLabelPublicSuffixes = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "com.au", "net.au", "org.au", "edu.au",
  "co.nz", "org.nz", "govt.nz", "com.sg", "net.sg", "org.sg", "co.in", "firm.in",
  "net.in", "org.in", "gen.in", "com.br", "com.mx", "com.tr", "com.cn", "com.hk",
  "com.tw", "co.za", "com.ar", "com.my", "com.ph", "com.pk", "com.ng", "com.eg",
]);
const hostedSiteSuffixes = new Set([
  "blogspot.com", "wordpress.com", "github.io", "wixsite.com", "webflow.io",
  "medium.com", "substack.com", "tumblr.com", "weebly.com",
]);

const approvedDomainSuffixes = [
  "portal", "group", "global", "company", "companies", "limited", "ltd", "plc",
  "brands", "foods", "fashion", "uae", "mena",
];

export function normalizedBrandText(value: string): string {
  return value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").trim();
}

export function buildInitialBrandOptionSearchQueries(query: string): string[] {
  return [
    `${query} official global company website about brands portfolio`,
    `${query} official UAE Middle East website brands portfolio`,
    `${query} company "our brands" official`,
  ];
}

export function interleaveSearchCitations<T extends { url: string }>(
  results: readonly { citations: readonly T[] }[],
  limit: number,
): T[] {
  const selected = new Map<string, T>();
  for (let citationIndex = 0; selected.size < limit; citationIndex += 1) {
    let foundAtIndex = false;
    for (const result of results) {
      const citation = result.citations[citationIndex];
      if (!citation) continue;
      foundAtIndex = true;
      if (!selected.has(citation.url)) selected.set(citation.url, citation);
      if (selected.size === limit) break;
    }
    if (!foundAtIndex) break;
  }
  return [...selected.values()];
}

export function companyIdentityNameMatchesQuery(query: string, name: string): boolean {
  const entered = normalizedBrandText(query);
  const candidate = normalizedBrandText(name);
  return !!entered && (candidate === entered || candidate.startsWith(`${entered} `));
}

export function isProductPageSource(source: FetchedSource): boolean {
  let path: string;
  try {
    path = new URL(source.url).pathname.toLowerCase();
  } catch {
    return true;
  }
  if (/(?:^|\/)(?:products?|pdp|items?|sku|dp)(?:\/|[-_.]|$)/i.test(path)) return true;
  const productSignals = `${source.title} ${source.text.slice(0, 5000)}`;
  return /\b(add to (?:cart|bag)|buy now|add to wishlist|select size|choose size|mrp)\b/i.test(productSignals);
}

function compact(value: string): string {
  return normalizedBrandText(value).replaceAll(" ", "");
}

function containsName(text: string, name: string): boolean {
  const normalizedText = ` ${normalizedBrandText(text)} `;
  const normalizedName = normalizedBrandText(name);
  return !!normalizedName && normalizedText.includes(` ${normalizedName} `);
}

export function registrableDomain(hostname: string): string {
  const labels = hostname.toLowerCase().replace(/^www\./, "").replace(/\.$/, "").split(".");
  if (labels.length < 2) return hostname.toLowerCase();
  const suffix = labels.slice(-2).join(".");
  if (hostedSiteSuffixes.has(suffix)) return suffix;
  return labels.slice(-(multiLabelPublicSuffixes.has(suffix) ? 3 : 2)).join(".");
}

export function sameRegistrableDomain(leftUrl: string, rightUrl: string): boolean {
  try {
    return registrableDomain(new URL(leftUrl).hostname) === registrableDomain(new URL(rightUrl).hostname);
  } catch {
    return false;
  }
}

function websiteFor(source: FetchedSource): string {
  const url = new URL(source.url);
  return `${url.protocol}//${registrableDomain(url.hostname)}`;
}

function domainMatchesEnteredCompany(query: string, domain: string): boolean {
  const labels = domain.split(".");
  if (labels.length < 2) return false;
  const registeredLabel = labels[0]!;
  const fullName = compact(query);
  if (registeredLabel === fullName) return true;
  const nameTokens = normalizedBrandText(query).split(" ").filter((token) => token.length >= 3);
  return nameTokens.some((token) => registeredLabel === token ||
    (registeredLabel.startsWith(token) &&
      approvedDomainSuffixes.some((suffix) => registeredLabel === `${token}${suffix}`)));
}

function hostMatchesHint(hostname: string, hint: string): boolean {
  const normalizedHost = hostname.toLowerCase().replace(/\.$/, "");
  const normalizedHint = hint.toLowerCase().replace(/^(?:https?:\/\/)?/, "").replace(/^www\./, "").replace(/\/.*$/, "").replace(/\.$/, "");
  return !!normalizedHint && (normalizedHost === normalizedHint || normalizedHost.endsWith(`.${normalizedHint}`));
}

export function groupFirstPartySources(
  query: string,
  sources: FetchedSource[],
  verifiedOfficialDomainHints: string[] = [],
): FetchedSource[][] {
  const groups = new Map<string, FetchedSource[]>();
  for (const source of sources) {
    if (!source.accessible || !source.text) continue;
    let domain: string;
    let hostname: string;
    try {
      hostname = new URL(source.url).hostname;
      domain = registrableDomain(hostname);
    } catch {
      continue;
    }
    const verifiedByNameDomain = domainMatchesEnteredCompany(query, domain);
    const verifiedByExplicitHint = verifiedOfficialDomainHints.some((hint) => hostMatchesHint(hostname, hint));
    if ((!verifiedByNameDomain && !verifiedByExplicitHint) ||
      !containsName(`${source.title} ${source.text}`, query)) continue;
    const group = groups.get(domain) ?? [];
    group.push(source);
    groups.set(domain, group);
  }
  return [...groups.values()];
}

export function companyOptionFromVerifiedHomepage(
  query: string,
  source: FetchedSource,
  verifiedHost: string,
): BrandOptionSelection | null {
  if (!source.accessible || !source.text || !source.title || source.title.length > 700 ||
    !source.text.includes(source.title) || isProductPageSource(source)) return null;
  let url: URL;
  try {
    url = new URL(source.url);
  } catch {
    return null;
  }
  const hostname = url.hostname.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  const expectedHost = verifiedHost.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  if (url.protocol !== "https:" || hostname !== expectedHost ||
    !containsName(source.title, query)) return null;
  const titleParts = source.title.split(/\s+[|·–—]\s+/);
  if (titleParts.length !== 2) return null;
  const name = titleParts[0]?.trim();
  if (!name || name.length > 120 || !companyIdentityNameMatchesQuery(query, name) ||
    !containsName(source.title, name)) return null;
  return {
    kind: "company",
    name,
    parent: null,
    category: null,
    website: websiteFor(source),
    sourceUrl: source.url,
    evidenceQuote: source.title,
    regionalEntity: null,
  };
}

const explicitlyRecognizableProductCategories = new Set([
  "smart tv", "smart tvs", "tv", "tvs", "television", "televisions",
  "home appliances", "appliances", "electronics", "consumer electronics",
  "audio", "soundbars", "smartphones", "mobile phones", "phones",
  "refrigerators", "fridges", "washing machines", "air conditioners",
  "laptops", "computers", "monitors", "projectors", "cameras",
]);

export function categoryOptionsFromVerifiedHomepage(
  company: BrandOptionSelection,
  source: FetchedSource,
): BrandOptionSelection[] {
  if (company.kind !== "company" || !source.accessible || !source.text ||
    source.url !== company.sourceUrl || source.title !== company.evidenceQuote ||
    !source.text.includes(source.title) || isProductPageSource(source)) return [];
  const titleParts = source.title.split(/\s+[|·–—]\s+/);
  if (titleParts.length !== 2 || titleParts[0]!.trim().toLowerCase() !== company.name.toLowerCase()) return [];
  const categoryTerms = titleParts[1]!.split(/\s*(?:,|&|\band\b)\s*/i).map((term) => term.trim());
  if (categoryTerms.length > 5 || categoryTerms.some((term) =>
    !term || term.length > 40 ||
    !explicitlyRecognizableProductCategories.has(normalizedBrandText(term)))) return [];
  return [...new Set(categoryTerms.map((term) => normalizedBrandText(term)))].map((normalizedName) => {
    const name = categoryTerms.find((term) => normalizedBrandText(term) === normalizedName)!;
    return {
      kind: "category",
      name,
      parent: company.name,
      category: null,
      website: company.website,
      sourceUrl: source.url,
      evidenceQuote: source.title,
      regionalEntity: null,
    };
  });
}

function hasPortfolioContext(quote: string): boolean {
  return /\b(brands?|portfolio)\b/i.test(quote);
}

function withoutLegalSuffix(value: string): string {
  return normalizedBrandText(value)
    .replace(/\b(incorporated|corporation|company|limited|ltd|plc|inc|llc|llp|corp|ag|sa|nv|se)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isSameCompany(parent: string, company: string): boolean {
  return withoutLegalSuffix(parent) === withoutLegalSuffix(company);
}

function standaloneBrandFromPageTitle(
  query: string,
  sources: FetchedSource[],
): BrandOptionSelection[] {
  const options: BrandOptionSelection[] = [];
  for (const source of sources) {
    if (!source.title || source.title.length > 700 || !source.text.includes(source.title)) continue;
    const registeredLabel = registrableDomain(new URL(source.url).hostname).split(".")[0]!;
    for (const part of source.title.split(/\s+[|·–—-]\s+/)) {
      const name = part.trim().replace(/^[\s:–—-]+|[\s:–—-]+$/g, "");
      if (!name || name.length > 120 || compact(name) !== registeredLabel || !containsName(name, query)) continue;
      options.push({
        kind: "brand",
        name,
        parent: null,
        category: null,
        website: websiteFor(source),
        sourceUrl: source.url,
        evidenceQuote: source.title,
      });
      break;
    }
  }
  return options;
}

export function validateBrandOptionExtractionsDetailed(
  query: string,
  sources: FetchedSource[],
  extracted: BrandOptionExtraction[],
): { options: BrandOptionSelection[]; counts: BrandOptionValidationCounts } {
  const counts: BrandOptionValidationCounts = {
    extractedOptions: extracted.length,
    validatedCompanies: 0,
    validatedBrands: 0,
    validatedCategories: 0,
    standaloneTitleBrands: 0,
    rejectedCompanyEvidence: 0,
    rejectedOptionNameEvidence: 0,
    rejectedParentEvidence: 0,
    unsupportedCategories: 0,
    rejectedCompanyIdentity: 0,
    rejectedCompanyProductPage: 0,
  };
  const sourceByUrl = new Map(sources.map((source) => [source.url, source]));
  const companies = extracted.flatMap((item) => {
    if (item.kind !== "company") return [];
    const source = sourceByUrl.get(item.sourceUrl);
    if (!source || !item.name || item.name.length > 120 || item.evidenceQuote.length < 12 ||
      item.evidenceQuote.length > 700 || !source.text.includes(item.evidenceQuote) ||
      !containsName(item.evidenceQuote, item.name)) {
      counts.rejectedCompanyEvidence += 1;
      return [];
    }
    if (!companyIdentityNameMatchesQuery(query, item.name)) {
      counts.rejectedCompanyIdentity += 1;
      return [];
    }
    if (isProductPageSource(source)) {
      counts.rejectedCompanyProductPage += 1;
      return [];
    }
    return [{ item, source }];
  });

  const validated: BrandOptionSelection[] = companies.map(({ item, source }) => ({
    kind: "company",
    name: item.name,
    parent: null,
    category: null,
    website: websiteFor(source),
    sourceUrl: source.url,
    evidenceQuote: item.evidenceQuote,
  }));
  counts.validatedCompanies = validated.length;
  const standaloneBrands = companies.length ? [] : standaloneBrandFromPageTitle(query, sources);
  validated.push(...standaloneBrands);
  counts.standaloneTitleBrands = standaloneBrands.length;
  const standaloneBrandNames = standaloneBrands.map((option) => option.name);
  for (const item of extracted) {
    if (item.kind === "company") continue;
    if (!item.name || item.name.length > 120 || item.evidenceQuote.length < 12 || item.evidenceQuote.length > 700) {
      counts.rejectedOptionNameEvidence += 1;
      continue;
    }
    const source = sourceByUrl.get(item.sourceUrl);
    if (!source || !source.text.includes(item.evidenceQuote) || !containsName(item.evidenceQuote, item.name)) {
      counts.rejectedOptionNameEvidence += 1;
      continue;
    }

    const company = item.parent
      ? companies.find(({ item: companyItem }) => isSameCompany(item.parent!, companyItem.name))
      : undefined;
    const standaloneParent = item.parent
      ? standaloneBrandNames.find((name) => isSameCompany(item.parent!, name))
      : undefined;
    const parentSource = item.parentEvidenceUrl ? sourceByUrl.get(item.parentEvidenceUrl) : undefined;
    const parentQuote = item.parentEvidenceQuote ?? "";
    const parentNamedInQuote = containsName(parentQuote, item.parent ?? "") ||
      (!!company && isSameCompany(query, company.item.name) && containsName(parentQuote, query));
    if (!item.parent || (!company && !standaloneParent) ||
      !parentSource || !sameRegistrableDomain(source.url, parentSource.url) ||
      !parentSource.text.includes(parentQuote) ||
      !parentNamedInQuote ||
      !hasPortfolioContext(parentQuote)) {
      counts.rejectedParentEvidence += 1;
      continue;
    }

    let category: string | null = null;
    if (item.category && item.categoryEvidenceQuote &&
      source.text.includes(item.categoryEvidenceQuote) &&
      containsName(item.categoryEvidenceQuote, item.name) &&
      containsName(item.categoryEvidenceQuote, item.category)) {
      category = item.category;
    } else if (item.category) {
      counts.unsupportedCategories += 1;
    }
    validated.push({
      kind: item.kind,
      name: item.name,
      parent: item.parent,
      category,
      website: websiteFor(source),
      sourceUrl: source.url,
      evidenceQuote: item.evidenceQuote,
    });
    if (item.kind === "brand") {
      counts.validatedBrands += 1;
      if (category && item.categoryEvidenceQuote) {
        validated.push({
          kind: "category",
          name: category,
          parent: item.parent,
          category: null,
          website: websiteFor(source),
          sourceUrl: source.url,
          evidenceQuote: item.categoryEvidenceQuote,
        });
        counts.validatedCategories += 1;
      }
    } else counts.validatedCategories += 1;
  }
  // A first-party brand detail page can identify a child brand even when the
  // extraction model fails to copy an exact quote. Require its literal title,
  // company name, and final URL slug to agree; do not infer from a brand list.
  for (const company of companies) {
    for (const source of sources) {
      if (!sameRegistrableDomain(source.url, company.source.url) ||
        !source.title || !source.text.includes(source.title) ||
        !containsName(source.title, query)) continue;
      const path = new URL(source.url).pathname.split("/").filter(Boolean);
      const brandIndex = path.findIndex((part) => /^brands?$/i.test(part));
      // Top-level /brands/foods pages may be category indexes, not brands.
      if (brandIndex < 0 || path.length - brandIndex < 3) continue;
      const slug = compact(path[path.length - 1]!);
      if (slug.length < 3 || ["ourbrands", "allbrands", "brands", "about"].includes(slug)) continue;
      const name = source.title.split(/\s+[|·–—-]\s+/)
        .map((part) => part.trim())
        .find((part) => compact(part) === slug && !isSameCompany(part, company.item.name));
      if (!name || validated.some((option) => option.kind === "brand" && option.name.toLowerCase() === name.toLowerCase())) continue;
      validated.push({
        kind: "brand",
        name,
        parent: company.item.name,
        category: null,
        website: websiteFor(source),
        sourceUrl: source.url,
        evidenceQuote: source.title,
      });
      counts.validatedBrands += 1;
    }
  }
  return { options: validated, counts };
}

export function validateBrandOptionExtractions(
  query: string,
  sources: FetchedSource[],
  extracted: BrandOptionExtraction[],
): BrandOptionSelection[] {
  return validateBrandOptionExtractionsDetailed(query, sources, extracted).options;
}