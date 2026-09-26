function compactBrandName(value: string): string {
  return value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "");
}

function normalizedBrandText(value: string): string {
  return value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").trim();
}

export function isWithinRecentResearchWindow(publishedAt: Date | null | undefined, now = new Date()): boolean {
  if (!publishedAt) return false;
  const cutoff = new Date(now);
  cutoff.setMonth(cutoff.getMonth() - 6);
  return publishedAt >= cutoff && publishedAt.getTime() <= now.getTime() + 86400000;
}

export function quoteExplicitlyLocatesInUae(quote: string | null | undefined): boolean {
  if (!quote) return false;
  return /\b(?:U\.?\s*A\.?\s*E\.?|United Arab Emirates|Emirati|Dubai|Abu Dhabi|Al Ain|Sharjah|Ajman|Fujairah|Ras[- ]Al[- ]Khaimah|RAK|Umm[- ]Al[- ]Quwain)\b/i.test(quote);
}

export function isEligibleQuickRunForDeepResearch(input: {
  scope: string;
  status: string;
  confirmedBrand: unknown;
  stages: Array<{ key: string; status: string }>;
}): boolean {
  if (input.scope !== "live_research_v1" || !input.confirmedBrand) return false;
  if (input.status !== "completed" && input.status !== "partial_success") return false;
  if (input.status === "partial_success" && !input.stages.some((stage) => stage.status === "limited_evidence")) return false;
  const states = new Map(input.stages.map((stage) => [stage.key, stage.status]));
  const focused = ["company_research", "recent_marketing", "campaign_research", "ooh_research", "current_promotion", "source_validation"];
  if (focused.some((key) => !states.has(key) || ["pending", "running"].includes(states.get(key)!))) return false;
  return ["competitor_discovery", "competitor_research", "ai_synthesis", "strategy_generation"]
    .every((key) => states.get(key) === "pending");
}

export function canRefreshProjectResearch(input: {
  hasHistoricalRuns: boolean;
  confirmedBrandName: string | null;
  officialWebsite: string | null;
  market: string | null;
  category: string | null;
  productFocus: string | null;
  pitchObjective: string | null;
  preferredMedia: string | null;
}): boolean {
  if (input.hasHistoricalRuns) return true;
  return !!input.confirmedBrandName?.trim() &&
    !!input.officialWebsite?.trim() &&
    !!input.market?.trim() &&
    !!(input.category?.trim() || input.productFocus?.trim()) &&
    !!input.pitchObjective?.trim() &&
    !!input.preferredMedia?.trim();
}

export function isSelfBrandCandidate(candidateName: string, brandAliases: string[]): boolean {
  const normalizedCandidate = normalizedBrandText(candidateName);
  return !!normalizedCandidate && brandAliases.some((alias) =>
    !!normalizedBrandText(alias) && normalizedBrandText(alias) === normalizedCandidate);
}

export function brandNameSimilarity(left: string, right: string): number {
  const a = compactBrandName(left);
  const b = compactBrandName(right);
  if (!a || !b) return 0;
  const matrix = Array.from({ length: a.length + 1 }, () =>
    Array.from({ length: b.length + 1 }, () => 0));
  for (let i = 0; i <= a.length; i += 1) matrix[i]![0] = i;
  for (let j = 0; j <= b.length; j += 1) matrix[0]![j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i]![j] = Math.min(
        matrix[i - 1]![j]! + 1,
        matrix[i]![j - 1]! + 1,
        matrix[i - 1]![j - 1]! + substitution,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        matrix[i]![j] = Math.min(matrix[i]![j]!, matrix[i - 2]![j - 2]! + 1);
      }
    }
  }
  return 1 - matrix[a.length]![b.length]! / Math.max(a.length, b.length);
}

export function isPlausibleBrandSpelling(entered: string, candidate: string): boolean {
  const similarity = brandNameSimilarity(entered, candidate);
  return similarity === 1 || (Math.min(compactBrandName(entered).length, compactBrandName(candidate).length) >= 4 &&
    similarity >= 0.8);
}

function isPlausibleBrandNameExtension(entered: string, candidate: string): boolean {
  const shortName = normalizedBrandText(entered);
  const fullName = normalizedBrandText(candidate);
  return compactBrandName(shortName).length >= 3 &&
    fullName.startsWith(`${shortName} `);
}

// A source's own "About us · Brand Name" title can recover a candidate when
// structured extraction misses it. It still has to pass all official-source checks.
export function officialBrandFromPageTitle(input: {
  enteredName: string;
  host: string;
  title: string;
  sourceText: string;
}): { name: string; evidenceQuote: string } | null {
  if (!input.sourceText.includes(input.title)) return null;
  for (const part of input.title.split(/\s+[|·–—]\s+/)) {
    const name = part.trim();
    if (name.length > 70 || !isPlausibleBrandNameExtension(input.enteredName, name)) continue;
    if (sourceBackedOfficialBrandEvidenceRejection({
      enteredName: input.enteredName,
      candidateName: name,
      host: input.host,
      title: input.title,
      sourceText: input.sourceText,
      evidenceQuote: input.title,
    }) === null) {
      return { name, evidenceQuote: input.title };
    }
  }
  return null;
}

export type BrandEvidenceRejectionReason =
  | "name_similarity_too_low"
  | "quote_not_exact_source_text"
  | "quote_does_not_name_candidate"
  | "official_page_does_not_name_candidate"
  | "official_domain_name_mismatch";

export function sourceBackedOfficialBrandEvidenceRejection(input: {
  enteredName: string;
  candidateName: string;
  host: string;
  title: string;
  sourceText: string;
  evidenceQuote: string;
}): BrandEvidenceRejectionReason | null {
  if (!isPlausibleBrandSpelling(input.enteredName, input.candidateName) &&
      !isPlausibleBrandNameExtension(input.enteredName, input.candidateName)) {
    return "name_similarity_too_low";
  }
  if (!input.sourceText.includes(input.evidenceQuote)) return "quote_not_exact_source_text";
  const normalizedName = normalizedBrandText(input.candidateName);
  if (!normalizedName || !` ${normalizedBrandText(input.evidenceQuote)} `.includes(` ${normalizedName} `)) {
    return "quote_does_not_name_candidate";
  }
  if (!normalizedBrandText(`${input.title} ${input.sourceText.slice(0, 4000)}`).includes(normalizedName)) {
    return "official_page_does_not_name_candidate";
  }
  const labels = input.host.toLowerCase().replace(/^www\./, "").split(".")
    .filter((part) => !["com", "net", "org", "ae", "sa", "uk", "co", "global", "group"].includes(part));
  const canonicalDomainName = compactBrandName(input.candidateName);
  const supportedRegionalSuffixes = ["me", "uae", "mena"];
  const matchesOfficialBrandDomain = labels.some((label) => {
    const compactLabel = compactBrandName(label);
    return compactLabel === canonicalDomainName ||
      supportedRegionalSuffixes.some((suffix) => compactLabel === `${canonicalDomainName}${suffix}`);
  });
  return matchesOfficialBrandDomain ? null : "official_domain_name_mismatch";
}

export function hasSourceBackedOfficialBrandEvidence(input: {
  enteredName: string;
  candidateName: string;
  host: string;
  title: string;
  sourceText: string;
  evidenceQuote: string;
}): boolean {
  return sourceBackedOfficialBrandEvidenceRejection(input) === null;
}

export function brandConfirmationAction(
  confirmedWebsite: string | null | undefined,
  selectedWebsite: string,
): "confirm" | "already_confirmed" | "conflict" {
  if (!confirmedWebsite) return "confirm";
  return confirmedWebsite === selectedWebsite ? "already_confirmed" : "conflict";
}

export function canResolveResearchGaps(confirmedBrand: unknown): boolean {
  return confirmedBrand !== null && confirmedBrand !== undefined;
}

export function canRetryFailedBrandResolution(
  status: string,
  confirmedBrand: unknown,
  selectedStages: string[],
): boolean {
  return !canResolveResearchGaps(confirmedBrand) && status === "failed" &&
    selectedStages.length === 1 && selectedStages[0] === "brand_resolution";
}

export function lastAttemptTimestamp(
  lastAttemptedAt: Date | null | undefined,
  requestedAt: Date | null | undefined,
): Date | null {
  return lastAttemptedAt ?? requestedAt ?? null;
}
