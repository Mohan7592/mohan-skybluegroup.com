import {
  HttpsSourceValidator,
  OpenAiStructuredLlmProvider,
  ResponsesWebSearchProvider,
  type FetchedSource,
} from "./live-research";
import {
  createBrandSelectionToken,
  validateRegionalEntityEvidence,
  type BrandOptionSelection,
} from "./brand-selection-token";
import type { RegionalEntityEvidence } from "./brand-selection-token";
import {
  groupFirstPartySources,
  registrableDomain,
  sameRegistrableDomain,
  validateBrandOptionExtractionsDetailed,
  normalizedBrandText,
  buildInitialBrandOptionSearchQueries,
  interleaveSearchCitations,
  isProductPageSource,
  companyOptionFromVerifiedHomepage,
  categoryOptionsFromVerifiedHomepage,
  type BrandOptionExtraction,
  type BrandOptionValidationCounts,
} from "./brand-options-rules";

export type BrandOption = BrandOptionSelection & { selectionToken: string };
export type BrandOptionsDiagnostics = {
  initialSearchQueries: number;
  initialCitations: number;
  initialFetchedSources: number;
  firstPartySources: number;
  rejectedFirstPartySources: number;
  candidateDomains: number;
  processedDomains: number;
  targetedSearchQueries: number;
  targetedCitations: number;
  targetedFetchedSources: number;
  extractionGroups: number;
  extractionFailures: number;
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
type BrandOptionSchema = { parse(value: unknown): { options: BrandOptionExtraction[] } };
type RegionalEntityExtraction = RegionalEntityEvidence | null;
type BrandOptionExtractionWithRegionalEntity = BrandOptionExtraction & {
  regionalEntity: RegionalEntityExtraction;
};

const searchProvider = new ResponsesWebSearchProvider();
const sourceValidator = new HttpsSourceValidator();
const llm = new OpenAiStructuredLlmProvider();
// Search hints, not suggestions: every option still needs a freshly fetched
// official page, an exact quote, and user selection.
const portfolioSearchHosts: Record<string, string[]> = {
  itc: ["itcportal.com"],
  unilever: ["unilever.com"],
  max: ["maxfashion.com"],
  hisense: ["hisenseme.com"],
};
const directOfficialHomepageHosts: Record<string, string[]> = {
  hisense: ["hisenseme.com"],
};
const extractionSchema: BrandOptionSchema = {
  parse(value) {
    if (!value || typeof value !== "object" || !Array.isArray((value as { options?: unknown }).options)) {
      throw new Error("AI extraction returned an invalid options structure");
    }
    const options = (value as { options: unknown[] }).options.map((item): BrandOptionExtractionWithRegionalEntity => {
      if (!item || typeof item !== "object") throw new Error("AI extraction returned an invalid option");
      const option = item as Record<string, unknown>;
      const regionalEntity = option.regionalEntity;
      if (!["company", "brand", "category"].includes(String(option.kind)) ||
        typeof option.name !== "string" ||
        !(typeof option.parent === "string" || option.parent === null) ||
        !(typeof option.category === "string" || option.category === null) ||
        typeof option.sourceUrl !== "string" ||
        typeof option.evidenceQuote !== "string" ||
        !(typeof option.parentEvidenceUrl === "string" || option.parentEvidenceUrl === null) ||
        !(typeof option.parentEvidenceQuote === "string" || option.parentEvidenceQuote === null) ||
        !(typeof option.categoryEvidenceQuote === "string" || option.categoryEvidenceQuote === null) ||
        !(regionalEntity === undefined || regionalEntity === null || (regionalEntity && typeof regionalEntity === "object" &&
          typeof (regionalEntity as Record<string, unknown>).name === "string" &&
          typeof (regionalEntity as Record<string, unknown>).sourceUrl === "string" &&
          typeof (regionalEntity as Record<string, unknown>).evidenceQuote === "string"))) {
        throw new Error("AI extraction returned an invalid option");
      }
      return {
        kind: option.kind as BrandOptionExtraction["kind"],
        name: option.name.trim(),
        parent: option.parent,
        category: option.category,
        sourceUrl: option.sourceUrl,
        evidenceQuote: option.evidenceQuote,
        parentEvidenceUrl: option.parentEvidenceUrl,
        parentEvidenceQuote: option.parentEvidenceQuote,
        categoryEvidenceQuote: option.categoryEvidenceQuote,
        regionalEntity: (regionalEntity ?? null) as RegionalEntityExtraction,
      };
    });
    return { options };
  },
};

function sourceEvidence(sources: FetchedSource[]): string {
  return sources.map((source) =>
    `URL: ${source.url}\nTITLE: ${source.title}\nTEXT: ${source.text.slice(0, 7_000)}`).join("\n\n");
}

async function searchTargetedOfficialPages(
  domain: string,
  signal?: AbortSignal,
): Promise<{ citations: number; sources: FetchedSource[] }> {
  const queries = [
    `site:${domain} brands portfolio`,
    `site:${domain} products categories collections`,
  ];
  const settled = await Promise.allSettled(queries.map((query) => searchProvider.search(query, signal)));
  const results = settled.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
  const citations = [...new Map(results.flatMap((result) => result.citations)
    .map((citation) => [citation.url, citation])).values()].slice(0, 6);
  const fetched = (await Promise.all(citations.map((citation) => sourceValidator.fetch(citation, signal))))
    .filter((source): source is FetchedSource => source !== null)
    .filter((source) => sameRegistrableDomain(source.url, `https://${domain}`));
  return { citations: citations.length, sources: fetched };
}

async function extractFromFirstPartyGroup(
  query: string,
  sources: FetchedSource[],
  signal?: AbortSignal,
): Promise<{ options: BrandOptionSelection[]; counts: BrandOptionValidationCounts }> {
  const sourcePriority = (source: FetchedSource) => {
    const domainLabel = registrableDomain(new URL(source.url).hostname).split(".")[0]!;
    const titleHasDomainIdentity = source.title.split(/\s+[|·–—-]\s+/)
      .some((part) => part.trim().toLowerCase().replace(/[^a-z0-9]+/g, "") === domainLabel);
    const hasEnteredQuery = normalizedBrandText(source.text).includes(normalizedBrandText(query));
    const hasPortfolioClue = /(brand|portfolio|product|categor|collection)/i.test(`${source.title} ${source.url}`);
    const hasIdentityClue = /(about|company|corporate|who[-\s]we[-\s]are)/i.test(`${source.title} ${source.url}`);
    return (titleHasDomainIdentity ? 4 : 0) + (hasEnteredQuery ? 2 : 0) +
      (hasPortfolioClue ? 1 : 0) + (hasIdentityClue ? 1 : 0) - (isProductPageSource(source) ? 2 : 0);
  };
  const extractionSources = [...sources]
    .sort((left, right) => sourcePriority(right) - sourcePriority(left))
    .slice(0, 12);
  const evidence = sourceEvidence(extractionSources);
  const extracted = await llm.json(
    `Extract only source-supported company, brand, and product category options from these pages on one first-party registrable domain. Return JSON exactly as {"options":[{"kind":"company"|"brand"|"category","name":"exact source-supported name","parent":"exact company name or null","category":"exact category or null","sourceUrl":"exact URL from sources","evidenceQuote":"verbatim quote naming the company, brand or category itself","parentEvidenceUrl":"exact URL from this same registrable domain containing explicit parent company portfolio context, or null for a company option","parentEvidenceQuote":"verbatim quote from parentEvidenceUrl explicitly connecting the named parent company to its brands/portfolio, or null for a company option","categoryEvidenceQuote":"verbatim quote from sourceUrl explicitly connecting this exact option name to this category, or null","regionalEntity":{"name":"exact UAE or regional legal/trading entity name","sourceUrl":"exact URL from these pages","evidenceQuote":"verbatim quote explicitly naming this option and that legal/trading entity, and explicitly stating its UAE or regional scope"} or null}]}. Include a company option only when the exact name appears in a non-product identity/about/company page quote and the name equals the entered company query or starts with it as a whole normalized token. Include brands/categories only when the source explicitly supports the name and parent relationship; the brand-name quote need not contain the parent. Verify the parent with an exact parentEvidenceQuote and parentEvidenceUrl from this same first-party registrable domain; this evidence may be on another fetched page. The parent must be a validated company option from these pages. A brand may have parent null only when its complete, exact name appears in a fetched source page title and exactly matches the registrable domain identity; never infer that exception from an ordinary text mention. Do not infer categories: if no quote explicitly connects the exact option name to the category, set category and categoryEvidenceQuote to null. Set regionalEntity to null unless one exact quote explicitly names this option and the entity and establishes its UAE/regional scope; never infer from the query, URL/domain, parent, or an unrelated entity mention. Do not propagate an entity from a company or brand to other options. Never invent or normalize names, URLs, quotes, or relationships. Every URL and quote must be exact. Return at most 10 options.`,
    evidence,
    extractionSchema,
    signal,
  );
  const validated = validateBrandOptionExtractionsDetailed(
    query,
    extractionSources,
    extracted.options,
  );
  const withRegionalEntities = extracted.options as unknown as BrandOptionExtractionWithRegionalEntity[];
  return {
    ...validated,
    options: validated.options.map((option) => ({
      ...option,
      regionalEntity: validateRegionalEntityEvidence(option, withRegionalEntities, extractionSources),
    })),
  };
}

export async function getBrandOptions(
  query: string,
  signal?: AbortSignal,
  reportDiagnostics?: (diagnostics: BrandOptionsDiagnostics) => void,
): Promise<BrandOption[]> {
  const diagnostics: BrandOptionsDiagnostics = {
    initialSearchQueries: 0,
    initialCitations: 0,
    initialFetchedSources: 0,
    firstPartySources: 0,
    rejectedFirstPartySources: 0,
    candidateDomains: 0,
    processedDomains: 0,
    targetedSearchQueries: 0,
    targetedCitations: 0,
    targetedFetchedSources: 0,
    extractionGroups: 0,
    extractionFailures: 0,
    extractedOptions: 0,
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
  const hints = portfolioSearchHosts[normalizedBrandText(query)] ?? [];
  const directSources: FetchedSource[] = [];
  for (const host of directOfficialHomepageHosts[normalizedBrandText(query)] ?? []) {
    let source: FetchedSource | null = null;
    try {
      source = await sourceValidator.fetch({ url: `https://${host}/`, title: host }, signal);
    } catch {
      // A direct verified-host fetch is an optimization; normal discovery remains available.
    }
    if (!source) continue;
    directSources.push(source);
    const option = companyOptionFromVerifiedHomepage(query, source, host);
    if (!option) continue;
    const directOptions = [option, ...categoryOptionsFromVerifiedHomepage(option, source)];
    diagnostics.initialFetchedSources = directSources.length;
    diagnostics.firstPartySources = 1;
    diagnostics.candidateDomains = 1;
    diagnostics.processedDomains = 1;
    diagnostics.validatedCompanies = 1;
    diagnostics.validatedCategories = directOptions.length - 1;
    reportDiagnostics?.(diagnostics);
    return directOptions.map((directOption) => ({
      ...directOption,
      selectionToken: createBrandSelectionToken(query, directOption),
    }));
  }
  const queries = buildInitialBrandOptionSearchQueries(query);
  diagnostics.initialSearchQueries = queries.length;
  const initialSettled = await Promise.allSettled(queries.map((item) => searchProvider.search(item, signal)));
  let successfulSearches = initialSettled.filter((result) => result.status === "fulfilled").length;
  let results = initialSettled.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
  let citations = interleaveSearchCitations(results, 12);
  const fetchedByUrl = new Map(directSources.map((source) => [source.url, source]));
  const fetchCitations = async (items: typeof citations) => {
    const newCitations = items.filter((citation) => !fetchedByUrl.has(citation.url));
    const sources = (await Promise.all(newCitations.map((citation) => sourceValidator.fetch(citation, signal))))
      .filter((source): source is FetchedSource => source !== null);
    for (const source of sources) fetchedByUrl.set(source.url, source);
  };
  await fetchCitations(citations);
  let fetched = [...fetchedByUrl.values()];
  let allDiscoveredGroups = groupFirstPartySources(query, fetched, hints);

  // Only spend a second search wave on explicit known-host hints when broad
  // discovery produced no verifiable official domain at all.
  if (!allDiscoveredGroups.length && hints.length) {
    const hintedQueries = hints.slice(0, 2).map((host) => `${query} official company brands site:${host}`);
    diagnostics.initialSearchQueries += hintedQueries.length;
    const hintedSettled = await Promise.allSettled(hintedQueries.map((item) => searchProvider.search(item, signal)));
    successfulSearches += hintedSettled.filter((result) => result.status === "fulfilled").length;
    const hintedResults = hintedSettled.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    results = [...results, ...hintedResults];
    citations = interleaveSearchCitations(hintedResults, 8);
    await fetchCitations(citations);
    fetched = [...fetchedByUrl.values()];
    allDiscoveredGroups = groupFirstPartySources(query, fetched, hints);
  }
  diagnostics.initialCitations = new Set(results.flatMap((result) => result.citations.map((citation) => citation.url))).size;
  diagnostics.initialFetchedSources = fetched.length;
  if (successfulSearches === 0) {
    reportDiagnostics?.(diagnostics);
    throw new Error("Brand search could not reach any sources. Please try again.");
  }
  const discoveredGroups = allDiscoveredGroups.slice(0, 4);
  diagnostics.candidateDomains = allDiscoveredGroups.length;
  diagnostics.processedDomains = discoveredGroups.length;
  diagnostics.firstPartySources = allDiscoveredGroups.flat().length;
  diagnostics.rejectedFirstPartySources = Math.max(0, fetched.length - diagnostics.firstPartySources);
  if (!discoveredGroups.length) {
    reportDiagnostics?.(diagnostics);
    return [];
  }

  const enrichedGroups = await Promise.all(discoveredGroups.map(async (group) => {
    if (group.some((source) => /\b(?:our\s+)?brands?\b|\bportfolio\b/i.test(`${source.title} ${source.text}`))) {
      return group;
    }
    const domain = registrableDomain(new URL(group[0]!.url).hostname);
    diagnostics.targetedSearchQueries += 2;
    const targeted = await searchTargetedOfficialPages(domain, signal);
    diagnostics.targetedCitations += targeted.citations;
    diagnostics.targetedFetchedSources += targeted.sources.length;
    return [...new Map([...group, ...targeted.sources].map((source) => [source.url, source])).values()];
  }));
  diagnostics.extractionGroups = enrichedGroups.length;
  const settledGroups = await Promise.allSettled(enrichedGroups.map((group) =>
    extractFromFirstPartyGroup(query, group, signal)));
  const extractedGroups = settledGroups.flatMap((result) => {
    if (result.status === "rejected") {
      diagnostics.extractionFailures += 1;
      return [];
    }
    const { counts, options } = result.value;
    diagnostics.extractedOptions += counts.extractedOptions;
    diagnostics.validatedCompanies += counts.validatedCompanies;
    diagnostics.validatedBrands += counts.validatedBrands;
    diagnostics.validatedCategories += counts.validatedCategories;
    diagnostics.standaloneTitleBrands += counts.standaloneTitleBrands;
    diagnostics.rejectedCompanyEvidence += counts.rejectedCompanyEvidence;
    diagnostics.rejectedOptionNameEvidence += counts.rejectedOptionNameEvidence;
    diagnostics.rejectedParentEvidence += counts.rejectedParentEvidence;
    diagnostics.unsupportedCategories += counts.unsupportedCategories;
    diagnostics.rejectedCompanyIdentity += counts.rejectedCompanyIdentity;
    diagnostics.rejectedCompanyProductPage += counts.rejectedCompanyProductPage;
    return [options];
  });
  if (diagnostics.extractionFailures === diagnostics.extractionGroups) {
    reportDiagnostics?.(diagnostics);
    throw new Error("Structured brand extraction failed for all candidate first-party domains");
  }
  const uniqueOptions = new Map<string, BrandOptionSelection>();
  for (let optionIndex = 0; optionIndex < Math.max(0, ...extractedGroups.map((group) => group.length)); optionIndex += 1) {
    for (const group of extractedGroups) {
      const option = group[optionIndex];
      if (!option) continue;
      const key = `${option.kind}:${option.name.toLowerCase()}:${option.parent?.toLowerCase() ?? ""}:${option.website}`;
      if (!uniqueOptions.has(key)) uniqueOptions.set(key, option);
      if (uniqueOptions.size === 10) break;
    }
    if (uniqueOptions.size === 10) break;
  }
  const deduplicated = [...uniqueOptions.values()];
  reportDiagnostics?.(diagnostics);
  return deduplicated.map((option) => ({
    ...option,
    selectionToken: createBrandSelectionToken(query, option),
  }));
}