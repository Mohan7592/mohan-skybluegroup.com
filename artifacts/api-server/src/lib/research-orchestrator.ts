import { createHash } from "node:crypto";
import { and, arrayContains, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import {
  campaignsTable,
  competitorsTable,
  db,
  pitchProjectsTable,
  researchClaimsTable,
  researchRunsTable,
  sourcesTable,
  strategyDecisionsTable,
} from "@workspace/db";
import { logger } from "./logger";
import {
  HttpsSourceValidator,
  isLiveResearchConfigured,
  OpenAiStructuredLlmProvider,
  ResponsesWebSearchProvider,
  type FetchedSource,
  type SearchCitation,
} from "./live-research";
import { getProjectIntelligence, loadProjectContext, type ProjectContext } from "./research";
import {
  brandConfirmationAction,
  canRetryFailedBrandResolution,
  canResolveResearchGaps,
  isEligibleQuickRunForDeepResearch,
  isSelfBrandCandidate,
  isPlausibleBrandSpelling,
  isWithinRecentResearchWindow,
  officialBrandFromPageTitle,
  quoteExplicitlyLocatesInUae,
  sourceBackedOfficialBrandEvidenceRejection,
} from "./research-orchestrator-rules";

const stageKeys = [
  "brand_resolution", "company_research", "competitor_discovery", "competitor_research",
  "recent_marketing", "campaign_research", "ooh_research", "current_promotion",
  "source_validation", "ai_synthesis", "strategy_generation",
] as const;
const pitchFocusedStages = [
  "company_research", "recent_marketing", "campaign_research", "ooh_research",
  "current_promotion", "source_validation",
];
const pitchFocusedScope = "live_research_pitch_v1";
const deepResearchStages = new Set(["competitor_discovery", "competitor_research", "ai_synthesis", "strategy_generation"]);
type StageState = "pending" | "running" | "complete" | "needs_review" | "limited_evidence" | "failed";
type RunStage = { key: string; status: StageState; note?: string };
type Candidate = {
  name: string;
  website: string;
  parent?: string | null;
  industry?: string | null;
  sourceUrl?: string | null;
  evidenceQuote?: string | null;
  regionalEntity?: string | null;
  regionalEntityEvidenceQuote?: string | null;
};
type CompetitorCandidate = { name: string; selected: boolean; relevance?: string; sourceUrl?: string | null };
type BrandExtraction = {
  name: string;
  parent: string | null;
  industry: string | null;
  sourceUrl: string;
  evidenceQuote: string;
  regionalEntity: string | null;
  regionalEntityEvidenceQuote: string | null;
};
type CompetitorExtraction = { name: string; relevance: string; sourceUrl: string };
type ClaimExtraction = {
  claim: string; category: string; claimType: "verified_fact" | "reported_claim" | "estimate";
  evidenceUrl: string; evidenceQuote: string; relatedBrand: string | null; competitorName: string | null;
};
type CompetitorAnalysis = {
  name: string; positioning: string | null; mainProducts: string | null; recentMarketing: string | null;
  outdoorActivity: string | null; mainMessage: string | null; strengths: string | null;
  observableGaps: string | null; currentPromotion: string | null; doohActivity: string | null;
  transitActivity: string | null; evidenceUrls: string[];
};
type CampaignData = {
  name: string; brandOrProduct: string | null; productFocus: string | null;
  startDate: string | null; endDate: string | null; geography: string | null;
  message: string | null; medium: string | null; location: string | null; evidenceQuote: string;
  evidenceUrl: string; evidenceStatus: "confirmed_ooh" | "likely_ooh" | "insufficient_evidence";
};
type StrategyData = {
  key: "why_now" | "business_trigger" | "marketing_trigger" | "competitor_trigger" | "ooh_gap" | "recommended_ooh" | "audience" | "territory" | "hypothesis" | "white_space";
  recommendation: string; rationale: string; evidenceUrls: string[];
};
type SynthesisData = { claims: ClaimExtraction[]; strategy: StrategyData[] };
type Validator<T> = { parse(value: unknown): T };
const requiredStrategyKeys = [
  "why_now",
  "business_trigger",
  "marketing_trigger",
  "competitor_trigger",
  "ooh_gap",
  "audience",
  "territory",
  "recommended_ooh",
  "hypothesis",
] as const;
const allowedStrategyKeys = new Set<string>([...requiredStrategyKeys, "white_space"]);
export interface ClaimExtractor {
  extract(evidence: string, topic: string, signal?: AbortSignal): Promise<ClaimExtraction[]>;
}
export interface StrategySynthesizer {
  synthesize(evidence: string, signal?: AbortSignal): Promise<SynthesisData>;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Structured response must be an object");
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string, max: number, min = 0): string {
  if (typeof value !== "string" || value.length < min || value.length > max) throw new Error(`Invalid structured field: ${field}`);
  return value;
}

function nullableText(value: unknown, field: string, max: number): string | null {
  return value === null ? null : text(value, field, max);
}

function optionalAnalysisText(value: unknown, max: number): string | null {
  return typeof value === "string" && value.length <= max ? value : null;
}

function urlText(value: unknown, field: string): string {
  const candidate = text(value, field, 2000, 1);
  try { new URL(candidate); } catch { throw new Error(`Invalid URL in structured field: ${field}`); }
  return candidate;
}

function array(value: unknown, field: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new Error(`Invalid structured list: ${field}`);
  return value;
}

function parseClaim(value: unknown): ClaimExtraction {
  const item = record(value);
  const claimType = text(item.claimType, "claimType", 40, 1);
  if (!["verified_fact", "reported_claim", "estimate"].includes(claimType)) throw new Error("Invalid claim type");
  return {
    claim: text(item.claim, "claim", 1200, 8),
    category: text(item.category, "category", 100, 3),
    claimType: claimType as ClaimExtraction["claimType"],
    evidenceUrl: urlText(item.evidenceUrl, "evidenceUrl"),
    evidenceQuote: text(item.evidenceQuote, "evidenceQuote", 500, 20),
    relatedBrand: nullableText(item.relatedBrand, "relatedBrand", 120),
    competitorName: nullableText(item.competitorName, "competitorName", 120),
  };
}

const brandExtractSchema: Validator<{ candidates: BrandExtraction[] }> = {
  parse(value) {
    const item = record(value);
    return { candidates: array(item.candidates, "candidates", 5).map((value) => {
      const candidate = record(value);
      return {
        // Responses models may naturally label the entity as "identity" when
        // returning citations. Accept that equivalent field but require the
        // exact citation URL and all application-facing values are rebuilt
        // from this bounded set before persistence.
        name: text(candidate.name ?? candidate.identity, "name", 120, 1),
        parent: candidate.parent === undefined ? null : nullableText(candidate.parent, "parent", 120),
        industry: candidate.industry === undefined ? null : nullableText(candidate.industry, "industry", 120),
        sourceUrl: urlText(candidate.sourceUrl, "sourceUrl"),
        evidenceQuote: text(candidate.evidenceQuote, "evidenceQuote", 500, 20),
        regionalEntity: candidate.regionalEntity === undefined ? null : nullableText(candidate.regionalEntity, "regionalEntity", 180),
        regionalEntityEvidenceQuote: candidate.regionalEntityEvidenceQuote === undefined
          ? null : nullableText(candidate.regionalEntityEvidenceQuote, "regionalEntityEvidenceQuote", 500),
      };
    }) };
  },
};
const likelyBrandSpellingsSchema: Validator<{ spellings: string[] }> = {
  parse(value) {
    const item = record(value);
    return {
      spellings: array(item.spellings, "spellings", 4)
        .map((value) => text(value, "spelling", 120, 2)),
    };
  },
};
const competitorExtractSchema: Validator<{ competitors: CompetitorExtraction[] }> = {
  parse(value) {
    const item = record(value);
    return { competitors: array(item.competitors, "competitors", 10).map((value) => {
      const competitor = record(value);
      return {
        name: text(competitor.name, "name", 120, 2),
        relevance: text(competitor.relevance, "relevance", 400),
        sourceUrl: urlText(competitor.sourceUrl, "sourceUrl"),
      };
    }) };
  },
};
const claimsSchema: Validator<{ claims: ClaimExtraction[] }> = {
  parse(value) {
    const item = record(value);
    return { claims: array(item.claims, "claims", 36).map(parseClaim) };
  },
};
const competitorAnalysisSchema: Validator<{ competitors: CompetitorAnalysis[] }> = {
  parse(value) {
    const item = record(value);
    const candidates = Array.isArray(item.competitors) ? item.competitors.slice(0, 10) : [];
    const competitors: CompetitorAnalysis[] = [];
    for (const value of candidates) {
      try {
        const competitor = record(value);
        const name = text(competitor.name, "name", 120, 2);
        const evidenceUrls: string[] = [];
        if (Array.isArray(competitor.evidenceUrls)) {
          for (const rawUrl of competitor.evidenceUrls.slice(0, 8)) {
            try { evidenceUrls.push(urlText(rawUrl, "evidenceUrls")); } catch { /* discard only the malformed URL */ }
          }
        }
        competitors.push({
          name,
          positioning: optionalAnalysisText(competitor.positioning, 1200),
          mainProducts: optionalAnalysisText(competitor.mainProducts, 1200),
          recentMarketing: optionalAnalysisText(competitor.recentMarketing, 1200),
          outdoorActivity: optionalAnalysisText(competitor.outdoorActivity, 1200),
          mainMessage: optionalAnalysisText(competitor.mainMessage, 1200),
          strengths: optionalAnalysisText(competitor.strengths, 1200),
          observableGaps: optionalAnalysisText(competitor.observableGaps, 1200),
          currentPromotion: optionalAnalysisText(competitor.currentPromotion, 1200),
          doohActivity: optionalAnalysisText(competitor.doohActivity, 1200),
          transitActivity: optionalAnalysisText(competitor.transitActivity, 1200),
          evidenceUrls,
        });
      } catch {
        // A malformed competitor item must not discard usable analysis for
        // the other selected competitors; the source-backed claims are saved
        // independently before this profile extraction.
      }
    }
    return { competitors };
  },
};
const campaignsSchema: Validator<{ campaigns: CampaignData[] }> = {
  parse(value) {
    const item = record(value);
    return { campaigns: array(item.campaigns, "campaigns", 20).map((value) => {
      const campaign = record(value);
      const nullableDate = (date: unknown, field: string): string | null => {
        if (date === null) return null;
        const result = text(date, field, 10, 10);
        const dateValue = new Date(`${result}T00:00:00.000Z`);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(result) ||
          !Number.isFinite(dateValue.getTime()) || dateValue.toISOString().slice(0, 10) !== result) {
          throw new Error(`Invalid date in ${field}`);
        }
        return result;
      };
      const evidenceStatus = text(campaign.evidenceStatus, "evidenceStatus", 32, 1);
      if (!["confirmed_ooh", "likely_ooh", "insufficient_evidence"].includes(evidenceStatus)) throw new Error("Invalid campaign evidence status");
      return {
        name: text(campaign.name, "name", 180, 2),
        brandOrProduct: nullableText(campaign.brandOrProduct, "brandOrProduct", 180),
        productFocus: nullableText(campaign.productFocus, "productFocus", 180),
        startDate: nullableDate(campaign.startDate, "startDate"),
        endDate: nullableDate(campaign.endDate, "endDate"),
        geography: nullableText(campaign.geography, "geography", 120),
        message: nullableText(campaign.message, "message", 700),
        medium: nullableText(campaign.medium, "medium", 80),
        location: nullableText(campaign.location, "location", 180),
        evidenceUrl: urlText(campaign.evidenceUrl, "evidenceUrl"),
        evidenceQuote: text(campaign.evidenceQuote, "evidenceQuote", 500, 20),
        evidenceStatus: evidenceStatus as CampaignData["evidenceStatus"],
      };
    }) };
  },
};
const synthesisSchema: Validator<SynthesisData> = {
  parse(value) {
    const item = record(value);
    const decisions = array(item.strategy, "strategy", 10).map((value) => {
      const decision = record(value);
      const key = text(decision.key, "key", 40, 1);
      if (!allowedStrategyKeys.has(key)) throw new Error("Invalid strategy key");
      return {
        key: key as StrategyData["key"],
        recommendation: text(decision.recommendation, "recommendation", 1200, 8),
        rationale: text(decision.rationale, "rationale", 1600, 8),
        evidenceUrls: array(decision.evidenceUrls, "evidenceUrls", 10).map((url) => urlText(url, "evidenceUrls")),
      };
    });
    const byKey = new Map<string, StrategyData>();
    for (const decision of decisions) {
      if (byKey.has(decision.key)) throw new Error(`Duplicate strategy key: ${decision.key}`);
      byKey.set(decision.key, decision);
    }
    const strategy: StrategyData[] = requiredStrategyKeys.map((key) => byKey.get(key) ?? ({
      key,
      recommendation: "Insufficient evidence to recommend a direction yet.",
      rationale: "The synthesis response omitted this required section, so no source-backed recommendation is available.",
      evidenceUrls: [],
    }));
    const whiteSpace = byKey.get("white_space");
    if (whiteSpace) strategy.push(whiteSpace);
    return {
      claims: array(item.claims, "claims", 36).map(parseClaim),
      strategy,
    };
  },
};

const searchProvider = new ResponsesWebSearchProvider();
const llm = new OpenAiStructuredLlmProvider();
const sourceValidator = new HttpsSourceValidator();
const activeRunIds = new Set<string>();
const runControllers = new Map<string, AbortController>();
const pendingClaims = new Set<Promise<unknown>>();
let shuttingDown = false;
function signalFor(runId: string): AbortSignal | undefined {
  return runControllers.get(runId)?.signal;
}
const claimCategoryGuidance: Record<string, string> = {
  company: "Use specific categories where supported: company.overview, company.business_model, company.products, company.key_markets, company.target_audience, company.positioning, and company.developments. Emit separate claims/categories for distinct fields; do not label all facts overview.",
  competitor: "Use specific categories where supported: competitor.official_identity, competitor.uae_presence, competitor.category, competitor.products, competitor.positioning, and competitor.recent_activity. Emit separate claims/categories for distinct fields; identity and UAE presence must be explicit in their quoted source.",
  marketing: "Prefer specific categories such as marketing.recent_activity, marketing.campaign, marketing.promotion, or marketing.product_launch rather than marketing.overview when the source supports them.",
};
const claimExtractor: ClaimExtractor = {
  async extract(evidence, topic, signal) {
    const result = await llm.json(
      `Extract only explicitly supported ${topic} facts. Every claim must include one exact, verbatim, contiguous evidenceQuote of at most 500 characters from its evidenceUrl source. The quote must substantively state the claim, not merely share a topic. Return JSON exactly as {"claims":[{"claim":"...","category":"${topic}.overview","claimType":"verified_fact|reported_claim|estimate","evidenceUrl":"exact source URL","evidenceQuote":"exact verbatim source passage","relatedBrand":null,"competitorName":null}]}. Categorize using ${topic}.* labels. ${claimCategoryGuidance[topic] ?? ""} Never estimate marketing budgets. A currency amount is not marketing spend unless that exact passage explicitly calls it marketing or advertising spend, budget, expenditure, investment, or cost.`,
      evidence,
      claimsSchema,
      signal,
    );
    return result.claims;
  },
};
const strategySynthesizer: StrategySynthesizer = {
  synthesize(evidence, signal) {
    return llm.json(
      "Generate evidence-grounded strategy recommendations and claims. The strategy array MUST contain exactly one entry for each of these nine keys: why_now, business_trigger, marketing_trigger, competitor_trigger, ooh_gap, audience, territory, recommended_ooh, hypothesis. You may add one optional white_space entry, but no other keys. Do not omit a required key; if the evidence is insufficient, use recommendation 'Insufficient evidence to recommend a direction yet.', explain exactly what evidence is missing, and provide an empty evidenceUrls array. Every claim must include one exact, verbatim, contiguous evidenceQuote of at most 500 characters from its cited source that substantively states it. Return JSON as {\"claims\":[{\"claim\":\"...\",\"category\":\"market.context\",\"claimType\":\"reported_claim\",\"evidenceUrl\":\"exact URL\",\"evidenceQuote\":\"exact source passage\",\"relatedBrand\":null,\"competitorName\":null}],\"strategy\":[{\"key\":\"why_now\",\"recommendation\":\"...\",\"rationale\":\"...\",\"evidenceUrls\":[\"exact URL\"]},{\"key\":\"business_trigger\",\"recommendation\":\"...\",\"rationale\":\"...\",\"evidenceUrls\":[]},{\"key\":\"marketing_trigger\",\"recommendation\":\"...\",\"rationale\":\"...\",\"evidenceUrls\":[]},{\"key\":\"competitor_trigger\",\"recommendation\":\"...\",\"rationale\":\"...\",\"evidenceUrls\":[]},{\"key\":\"ooh_gap\",\"recommendation\":\"...\",\"rationale\":\"...\",\"evidenceUrls\":[]},{\"key\":\"audience\",\"recommendation\":\"...\",\"rationale\":\"...\",\"evidenceUrls\":[]},{\"key\":\"territory\",\"recommendation\":\"...\",\"rationale\":\"...\",\"evidenceUrls\":[]},{\"key\":\"recommended_ooh\",\"recommendation\":\"...\",\"rationale\":\"...\",\"evidenceUrls\":[]},{\"key\":\"hypothesis\",\"recommendation\":\"...\",\"rationale\":\"...\",\"evidenceUrls\":[]} ]}. Interpretations are recommendations, not factual assertions. Only cite evidence URLs provided. A currency amount is not marketing spend unless its exact passage explicitly identifies marketing or advertising spend/budget/expenditure/investment/cost.",
      evidence,
      synthesisSchema,
      signal,
    );
  },
};

function initialStages(): RunStage[] {
  return stageKeys.map((key) => ({ key, status: "pending" }));
}

function selectedStagesFromRetryScope(scope: string): string[] | null {
  if (!scope.startsWith("retry:")) return null;
  const parts = scope.slice("retry:".length).split(":");
  if (parts.length !== 2 || !parts[0]) return null;
  const stages = parts[1]!.split(",").filter(Boolean);
  if (!stages.length || stages.some((stage) => !stageKeys.includes(stage as typeof stageKeys[number]))) return null;
  return [...new Set(stages)];
}

function updateStage(stages: RunStage[], key: string, status: StageState, note?: string): RunStage[] {
  return stages.map((stage) => stage.key === key ? { key, status, ...(note ? { note: note.slice(0, 500) } : {}) } : stage);
}

function hostname(raw: string): string | null {
  try { return new URL(raw).hostname.toLowerCase().replace(/^www\./, ""); } catch { return null; }
}

function origin(raw: string): string | null {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" ? `${url.origin}/` : null;
  } catch { return null; }
}

function normalized(value: string): string {
  return value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").trim();
}

const claimStopWords = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "by", "for", "from", "has", "have", "in",
  "into", "is", "its", "of", "on", "or", "that", "the", "their", "this", "to", "was", "were", "will",
  "with", "under", "over", "more", "less", "than", "which", "who", "what", "where", "when", "while",
]);

function exactQuoteSupportsClaim(claim: ClaimExtraction, source: FetchedSource): boolean {
  const quote = claim.evidenceQuote;
  if (quote.length < 20 || quote.length > 500 || !source.text.includes(quote)) return false;
  const tokens = normalized(claim.claim).split(" ").filter((token) =>
    token.length > 2 && !claimStopWords.has(token) || /^\d/.test(token));
  const claimNegation = /\b(not|no|never|without|denied|declined|failed|unavailable)\b/i.test(claim.claim);
  const supportedSentence = quote.split(/(?<=[.!?])\s+/).some((sentence) => {
    const sentenceTokens = normalized(sentence).split(" ");
    let cursor = -1;
    for (const token of tokens) {
      const index = sentenceTokens.indexOf(token, cursor + 1);
      if (index < 0 || cursor >= 0 && index - cursor > 5) return false;
      cursor = index;
    }
    const quoteNegation = /\b(not|no|never|without|denied|declined|failed|unavailable)\b/i.test(sentence);
    return tokens.length >= 2 && claimNegation === quoteNegation;
  });
  if (!supportedSentence) return false;
  const mentionsMoney = /\b(?:AED|USD|EUR|GBP)\s?[\d,.]+|\b[\d,.]+\s?(?:AED|USD|EUR|GBP)\b|[$€£]\s?[\d,.]+/i;
  const budgetRelated = /(?:marketing|advertising)[\s._-]+(?:budget|spend|expenditure|investment|costs?)/i.test(`${claim.category} ${claim.claim}`);
  if ((budgetRelated || mentionsMoney.test(claim.claim)) &&
    !/\b(?:marketing|advertising)[\s-]+(?:budget|spend|expenditure|investment|costs?)\b/i.test(quote)) return false;
  return true;
}

function campaignDedupeKey(campaign: CampaignData, brand: string, market: string): string {
  const approximateDate = campaign.startDate?.slice(0, 7) ?? campaign.endDate?.slice(0, 7) ?? "undated";
  const key = [brand, campaign.brandOrProduct ?? campaign.productFocus ?? campaign.name, approximateDate, campaign.geography ?? market, campaign.name]
    .map(normalized).join("|");
  return createHash("sha256").update(key).digest("hex");
}

function validateCampaignEvidence(campaign: CampaignData, source: FetchedSource): CampaignData | null {
  const quote = campaign.evidenceQuote;
  if (quote.length < 20 || quote.length > 500 || !source.text.includes(quote)) return null;
  const name = normalized(campaign.name);
  const quoteSentences = quote.split(/(?<=[.!?])\s+/);
  const oohMedium = /\b(?:billboards?|bus shelters?|transit advertising|metro advertising|taxi advertising|airport advertising|vehicle wraps?|digital bridge screens?|bridge screens?|roadside screens?|lamp posts?)\b/i;
  const oohContext = /\b(?:ooh|dooh|out.of.home|outdoor advertising|outdoor campaign)\b/i;
  const namedSentence = quoteSentences.find((sentence) => normalized(sentence).includes(name));
  const titleNamesCampaign = name.length >= 8 && normalized(source.title).includes(name);
  // Some case studies name a campaign in the page title and describe its
  // medium as "the campaign" in the article. Both must be on the fetched page.
  const quotedMediumSentence = quoteSentences.find((sentence) =>
    oohContext.test(sentence) && normalized(sentence) !== normalized(source.title));
  const campaignSentence = quoteSentences.find((sentence) =>
    normalized(sentence).includes(name) && oohContext.test(sentence) &&
    normalized(sentence) !== normalized(source.title)) ??
    (titleNamesCampaign ? quotedMediumSentence : undefined) ?? namedSentence;
  if (!name || !campaignSentence) return null;
  const supported = (value: string | null): string | null =>
    value && normalized(campaignSentence).includes(normalized(value)) ? value : null;
  if (!quoteExplicitlyLocatesInUae(campaignSentence) &&
    !quoteExplicitlyLocatesInUae(supported(campaign.geography))) return null;
  const dateInSentence = (value: string | null): string | null => {
    if (!value || !campaignSentence.includes(value)) return null;
    return value;
  };
  let startDate = dateInSentence(campaign.startDate);
  let endDate = dateInSentence(campaign.endDate);
  const parsedStart = startDate ? new Date(`${startDate}T00:00:00.000Z`).getTime() : NaN;
  const parsedEnd = endDate ? new Date(`${endDate}T00:00:00.000Z`).getTime() : NaN;
  if (!Number.isFinite(parsedStart) || !Number.isFinite(parsedEnd) || parsedStart > parsedEnd) {
    startDate = null;
    endDate = null;
  }
  // OOH/outdoor is a channel-level label, not evidence of a format. Only
  // persist a medium when the source names a concrete format or placement.
  const explicitMedium = [
    "digital bridge screens", "bridge screens", "roadside screens", "bus shelters",
    "vehicle wraps", "billboards", "transit advertising", "metro advertising",
    "taxi advertising", "airport advertising", "lamp posts",
  ].find((phrase) => normalized(campaignSentence).includes(phrase));
  const medium = campaign.medium && oohMedium.test(campaign.medium) &&
    normalized(campaignSentence).includes(normalized(campaign.medium))
    ? campaign.medium : explicitMedium ?? null;
  const location = supported(campaign.location);
  const explicitOoh = !!explicitMedium && normalized(campaignSentence) !== normalized(source.title);
  return {
    ...campaign,
    brandOrProduct: supported(campaign.brandOrProduct),
    productFocus: supported(campaign.productFocus),
    startDate,
    endDate,
    geography: supported(campaign.geography),
    message: supported(campaign.message),
    medium,
    location,
    evidenceStatus: explicitOoh && medium
      ? campaign.evidenceStatus === "confirmed_ooh" ? "confirmed_ooh" : "likely_ooh"
      : "insufficient_evidence",
  };
}

function currentDated(source: FetchedSource | undefined, campaign: CampaignData): boolean {
  if (!source?.publishedAt || !campaign.startDate || !campaign.endDate) return false;
  const today = new Date().toISOString().slice(0, 10);
  const cutoff = Date.now() - 90 * 86400000;
  return campaign.startDate <= today && campaign.endDate >= today &&
    source.publishedAt.getTime() >= cutoff && source.publishedAt.getTime() <= Date.now() + 86400000;
}

export function isResearchConfigured(): boolean {
  return isLiveResearchConfigured();
}

export async function createResearchRun(project: ProjectContext) {
  const run = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${"research-active:" + project.id}))`);
    const [active] = await tx.select({ id: researchRunsTable.id }).from(researchRunsTable).where(and(
      eq(researchRunsTable.projectId, project.id),
      inArray(researchRunsTable.status, ["queued", "running"]),
    )).limit(1);
    if (active) throw new Error("A research run is already queued or running for this project");
    const [created] = await tx.insert(researchRunsTable).values({
      projectId: project.id,
      scope: "live_research_v1",
      status: "queued",
      stage: "brand_resolution",
      stages: initialStages(),
      brand: project.clientName,
      lastAttemptedAt: new Date(),
      market: project.market,
      focus: project.productFocus,
    }).returning();
    return created;
  });
  if (!run) throw new Error("Could not create research run");
  void runBrandResolution(run.id, project).catch((error: unknown) => {
    logger.error({ err: error, researchRunId: run.id }, "Research brand resolution failed");
    void markRunFailed(run.id, error);
  });
  return await getRun(project.id, run.id);
}

export async function createResearchRunWithConfirmedBrand(
  project: ProjectContext,
  selected: { name: string; website: string; parent: string | null; category: string | null; sourceUrl: string; evidenceQuote: string },
) {
  const candidate: Candidate = {
    name: selected.name,
    website: selected.website,
    parent: selected.parent,
    industry: selected.category,
    sourceUrl: selected.sourceUrl,
    evidenceQuote: selected.evidenceQuote,
  };
  const run = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${"research-active:" + project.id}))`);
    const [active] = await tx.select({ id: researchRunsTable.id }).from(researchRunsTable).where(and(
      eq(researchRunsTable.projectId, project.id),
      inArray(researchRunsTable.status, ["queued", "running"]),
    )).limit(1);
    if (active) throw new Error("A research run is already queued or running for this project");
    const [created] = await tx.insert(researchRunsTable).values({
      projectId: project.id,
      scope: pitchFocusedScope,
      status: "queued",
      stage: "company_research",
      stages: updateStage(initialStages(), "brand_resolution", "complete"),
      brand: selected.name,
      confirmedBrand: candidate,
      lastAttemptedAt: new Date(),
      market: project.market,
      focus: project.productFocus,
    }).returning();
    return created;
  });
  if (!run) throw new Error("Could not create research run");
  void runRemainingStages(run.id, project, candidate, [], pitchFocusedStages).catch((error: unknown) => {
    logger.error({ err: error, researchRunId: run.id }, "Pitch-focused research failed");
    void markRunFailed(run.id, error);
  });
  return run;
}

async function loadRun(runId: string) {
  const [run] = await db.select().from(researchRunsTable).where(eq(researchRunsTable.id, runId));
  if (!run) throw new Error("Research run not found");
  return run;
}

async function saveStage(runId: string, stage: string, status: StageState, note?: string): Promise<void> {
  const run = await loadRun(runId);
  const stages = updateStage(run.stages as RunStage[], stage, status, note);
  await db.update(researchRunsTable).set({ stage, stages }).where(and(
    eq(researchRunsTable.id, runId),
    eq(researchRunsTable.status, "running"),
  ));
}

async function buildCoverageSnapshot(project: ProjectContext, runId: string, asOf: Date) {
  const intelligence = await getProjectIntelligence(project, asOf, runId);
  return intelligence.quality;
}

async function backfillCoverageBeforeRetry(project: ProjectContext, run: Awaited<ReturnType<typeof loadRun>>): Promise<void> {
  if (run.coverageSnapshot) return;
  const capturedAt = new Date();
  try {
    const snapshot = await buildCoverageSnapshot(project, run.id, capturedAt);
    await db.update(researchRunsTable).set({
      coverageSnapshot: snapshot as Record<string, unknown>,
      coverageSnapshotAt: capturedAt,
      coverageSnapshotStatus: "backfilled_before_retry",
    }).where(and(eq(researchRunsTable.id, run.id), isNull(researchRunsTable.coverageSnapshot)));
  } catch (error) {
    logger.warn({ err: error, researchRunId: run.id }, "Could not backfill research coverage snapshot before retry");
  }
}

async function markRunFailed(runId: string, error: unknown): Promise<void> {
  const run = await loadRun(runId);
  const message = error instanceof Error ? error.message : "Research pipeline failed";
  const completedAt = new Date();
  let coverageSnapshot: Record<string, unknown> | null = null;
  try {
    const project = await loadProjectContext(run.projectId);
    if (project) coverageSnapshot = await buildCoverageSnapshot(project, run.id, completedAt) as Record<string, unknown>;
  } catch (snapshotError) {
    logger.warn({ err: snapshotError, researchRunId: runId }, "Could not capture failed-run coverage snapshot");
  }
  await db.update(researchRunsTable).set({
    status: "failed",
    stage: run.stage,
    errorMessage: message.slice(0, 1000),
    stages: updateStage(run.stages as RunStage[], run.stage, "failed", message),
    completedAt,
    coverageSnapshot,
    coverageSnapshotAt: coverageSnapshot ? completedAt : null,
    coverageSnapshotStatus: coverageSnapshot ? "captured_at_completion" : "unavailable",
  }).where(and(eq(researchRunsTable.id, runId), eq(researchRunsTable.status, "running")));
  activeRunIds.delete(runId);
  runControllers.delete(runId);
}

async function claimQueuedRun(runId: string): Promise<AbortController | null> {
  if (shuttingDown || activeRunIds.has(runId)) return null;
  const controller = new AbortController();
  activeRunIds.add(runId);
  runControllers.set(runId, controller);
  const claimPromise = (async () => db.update(researchRunsTable).set({ status: "running", startedAt: new Date() })
    .where(and(eq(researchRunsTable.id, runId), eq(researchRunsTable.status, "queued")))
    .returning({ id: researchRunsTable.id }))();
  pendingClaims.add(claimPromise);
  let claimed: { id: string } | undefined;
  try {
    [claimed] = await claimPromise;
  } catch (error) {
    activeRunIds.delete(runId);
    runControllers.delete(runId);
    throw error;
  } finally {
    pendingClaims.delete(claimPromise);
  }
  if (!claimed || shuttingDown) {
    controller.abort();
    if (claimed && shuttingDown) {
      const run = await loadRun(runId);
      await db.update(researchRunsTable).set({
        status: "queued",
        stages: updateStage(run.stages as RunStage[], run.stage, "pending", "Interrupted by server shutdown; queued for safe resume"),
        errorMessage: "Interrupted by server shutdown; queued for safe resume",
        completedAt: null,
      }).where(and(eq(researchRunsTable.id, runId), eq(researchRunsTable.status, "running")));
    }
    activeRunIds.delete(runId);
    runControllers.delete(runId);
    return null;
  }
  return controller;
}

async function queueActiveRunsForShutdown(): Promise<void> {
  shuttingDown = true;
  for (const controller of runControllers.values()) controller.abort();
  while (pendingClaims.size) await Promise.allSettled([...pendingClaims]);
  for (const runId of activeRunIds) {
    try {
      const run = await loadRun(runId);
      const stages = updateStage(run.stages as RunStage[], run.stage, "pending", "Interrupted by server shutdown; queued for safe resume");
      await db.update(researchRunsTable).set({
        status: "queued",
        stages,
        errorMessage: "Interrupted by server shutdown; queued for safe resume",
        completedAt: null,
      }).where(and(eq(researchRunsTable.id, runId), eq(researchRunsTable.status, "running")));
    } catch (error) {
      logger.error({ err: error, researchRunId: runId }, "Could not queue interrupted research run");
    }
  }
  process.exit(0);
}

async function gather(query: string, signal?: AbortSignal): Promise<{ searchText: string; sources: FetchedSource[] }> {
  const results = await searchProvider.search(query, signal);
  const unique = [...new Map(results.citations.map((citation) => [citation.url, citation])).values()].slice(0, 5);
  const fetched = await Promise.all(unique.map((citation) => sourceValidator.fetch(citation, signal)));
  const sources = fetched.filter((source): source is FetchedSource => source !== null);
  // Preserve inaccessible search citations as weak sources. Their snippets are
  // deliberately not promoted into claim-generation input.
  for (const citation of unique) {
    if (sources.some((source) => source.url === citation.url)) continue;
    let publisher = "Unknown publisher";
    try { publisher = new URL(citation.url).hostname; } catch { /* citation is stored only as weak evidence */ }
    sources.push({
      ...citation,
      publisher,
      text: "",
      publishedAt: null,
      retrievedAt: new Date(),
      qualityScore: 5,
      sourceKind: "inaccessible_search_citation",
      accessible: false,
    });
  }
  return { searchText: results.text.slice(0, 12_000), sources };
}

function citationPriority(url: string, officialWebsite?: string): number {
  const host = hostname(url) ?? "";
  let path = "";
  try { path = new URL(url).pathname; } catch { return 0; }
  const officialHost = officialWebsite ? hostname(officialWebsite) : null;
  if (officialHost && (host === officialHost || host.endsWith(`.${officialHost}`))) return 100;
  if (/(newsroom|press|media|investor|about|company)/i.test(url)) return 80;
  if (/(ooh\.ae|jcdecaux|clearchannel|clear-channel|lmar|hypermedia|motivate|phdmedia|mullenlowe)/i.test(host)) return 76;
  if (/(campaignme|arabianbusiness|zawya|thenationalnews|gulfbusiness|khaleejtimes|gulfnews|emirates247|lovin|timeout|whatson)/i.test(host)) return 72;
  if (/(instagram|facebook|linkedin|tiktok|x\.com|twitter|youtube)/i.test(host)) return 55;
  if (/(event|festival|expo|conference)/i.test(`${host}${path}`) || host.endsWith(".ae")) return 50;
  return 40;
}

async function gatherPlanned(
  queries: string[],
  signal?: AbortSignal,
  officialWebsite?: string,
): Promise<{ searchText: string; sources: FetchedSource[] }> {
  const uniqueQueries = [...new Map(queries.map((query) => [normalized(query), query])).values()].slice(0, 4);
  const results = await Promise.all(uniqueQueries.map((query) => searchProvider.search(query, signal)));
  const citations = [...new Map(results.flatMap((result) => result.citations)
    .map((citation) => [citation.url, citation])).values()]
    .sort((left, right) => citationPriority(right.url, officialWebsite) - citationPriority(left.url, officialWebsite))
    .slice(0, 8);
  const fetched = await Promise.all(citations.map((citation) => sourceValidator.fetch(citation, signal)));
  const sources = fetched.filter((source): source is FetchedSource => source !== null);
  for (const citation of citations) {
    if (sources.some((source) => source.url === citation.url)) continue;
    let publisher = "Unknown publisher";
    try { publisher = new URL(citation.url).hostname; } catch { /* retained only as weak evidence */ }
    sources.push({
      ...citation,
      publisher,
      text: "",
      publishedAt: null,
      retrievedAt: new Date(),
      qualityScore: 5,
      sourceKind: "inaccessible_search_citation",
      accessible: false,
    });
  }
  return {
    searchText: results.map((result) => result.text).join("\n").slice(0, 12_000),
    sources,
  };
}

async function persistSources(runId: string, project: ProjectContext, sources: FetchedSource[]): Promise<Map<string, { id: string; source: FetchedSource }>> {
  const found = new Map<string, { id: string; source: FetchedSource }>();
  const run = await loadRun(runId);
  const confirmedHost = run.confirmedBrand?.website ? hostname(run.confirmedBrand.website) : null;
  const existingRows = await db.select({ id: sourcesTable.id, url: sourcesTable.url }).from(sourcesTable)
    .where(eq(sourcesTable.researchRunId, runId));
  const existing = new Map(existingRows.filter((row) => row.url).map((row) => [row.url as string, row.id]));
  for (const source of sources) {
    const sourceHost = hostname(source.url);
    if (confirmedHost && sourceHost && (sourceHost === confirmedHost || sourceHost.endsWith(`.${confirmedHost}`))) {
      source.sourceKind = "official_company";
      source.qualityScore = source.publishedAt ? Math.max(source.qualityScore, 92) : Math.min(source.qualityScore, 35);
    }
    const existingId = existing.get(source.url);
    if (existingId) {
      found.set(source.url, { id: existingId, source });
      continue;
    }
    const [saved] = await db.insert(sourcesTable).values({
      researchRunId: runId,
      title: source.title.slice(0, 300),
      url: source.url,
      publisher: source.publisher.slice(0, 180),
      publishedAt: source.publishedAt,
      geography: project.market,
      snippet: source.text ? source.text.slice(0, 900) : null,
      qualityScore: source.qualityScore,
      sourceKind: source.sourceKind,
      retrievedAt: source.retrievedAt,
    }).returning({ id: sourcesTable.id });
    if (saved) {
      found.set(source.url, { id: saved.id, source });
      existing.set(source.url, saved.id);
    }
  }
  const total = await db.select({ id: sourcesTable.id }).from(sourcesTable).where(eq(sourcesTable.researchRunId, runId));
  await db.update(researchRunsTable).set({ sourcesFound: total.length }).where(eq(researchRunsTable.id, runId));
  return found;
}

type StoredSourceReference = { id: string; title: string; url: string | null; qualityScore: number | null; sourceKind: string | null };
type ApprovedClaimReference = {
  id: string;
  claim: string;
  category: string;
  methodology: string | null;
  sourceId: string;
  title: string;
  url: string | null;
};

function exactQuoteFromMethodology(methodology: string | null): string | null {
  const prefix = "Source-exact excerpt: “";
  if (!methodology?.startsWith(prefix) || !methodology.endsWith("”")) return null;
  const quote = methodology.slice(prefix.length, -1);
  return quote.length >= 20 && quote.length <= 500 ? quote : null;
}

async function sourceLineage(runId: string, projectId: string): Promise<StoredSourceReference[]> {
  const rows: StoredSourceReference[] = [];
  const seenRuns = new Set<string>();
  let currentId: string | null = runId;
  while (currentId && !seenRuns.has(currentId)) {
    seenRuns.add(currentId);
    const [run] = await db.select({ id: researchRunsTable.id, scope: researchRunsTable.scope })
      .from(researchRunsTable).where(and(
        eq(researchRunsTable.id, currentId),
        eq(researchRunsTable.projectId, projectId),
      ));
    if (!run) break;
    const sources = await db.select({
      id: sourcesTable.id,
      title: sourcesTable.title,
      url: sourcesTable.url,
      qualityScore: sourcesTable.qualityScore,
      sourceKind: sourcesTable.sourceKind,
    }).from(sourcesTable).where(eq(sourcesTable.researchRunId, currentId))
      .orderBy(desc(sourcesTable.qualityScore));
    rows.push(...sources);
    if (!run.scope.startsWith("retry:")) break;
    currentId = run.scope.slice("retry:".length).split(":")[0] ?? null;
  }
  return rows;
}

async function approvedClaimReferences(projectId: string): Promise<ApprovedClaimReference[]> {
  const rows = await db.select({
    id: researchClaimsTable.id,
    claim: researchClaimsTable.claim,
    category: researchClaimsTable.category,
    methodology: researchClaimsTable.methodology,
    sourceId: sourcesTable.id,
    title: sourcesTable.title,
    url: sourcesTable.url,
  }).from(researchClaimsTable).innerJoin(sourcesTable, eq(researchClaimsTable.sourceId, sourcesTable.id))
    .where(and(
      eq(researchClaimsTable.projectId, projectId),
      eq(researchClaimsTable.status, "approved"),
      eq(researchClaimsTable.isDemo, false),
    ))
    .orderBy(desc(researchClaimsTable.publishedAt))
    .limit(60);
  return rows.filter((row) => !!row.url && !!exactQuoteFromMethodology(row.methodology));
}

async function hydratePriorEvidence(
  runId: string,
  project: ProjectContext,
  signal: AbortSignal,
  includeApprovedClaimSources: boolean,
): Promise<{ sources: Map<string, { id: string; source: FetchedSource }>; approvedClaims: ApprovedClaimReference[] }> {
  const approvedClaims = includeApprovedClaimSources ? await approvedClaimReferences(project.id) : [];
  const storedSources = await sourceLineage(runId, project.id);
  const sourceById = new Map<string, StoredSourceReference>();
  for (const claim of approvedClaims) {
    if (!sourceById.has(claim.sourceId) && claim.url) {
      sourceById.set(claim.sourceId, {
        id: claim.sourceId,
        title: claim.title,
        url: claim.url,
        qualityScore: null,
        sourceKind: null,
      });
    }
  }
  for (const source of storedSources) {
    if (source.url && source.sourceKind !== "inaccessible_search_citation" && !sourceById.has(source.id)) {
      sourceById.set(source.id, source);
    }
  }

  const fetchedSources: FetchedSource[] = [];
  const uniqueByUrl = new Map<string, StoredSourceReference>();
  for (const stored of sourceById.values()) {
    if (stored.url && !uniqueByUrl.has(stored.url)) uniqueByUrl.set(stored.url, stored);
  }
  const candidates = [...uniqueByUrl.values()].slice(0, 20);
  const fetchedByStoredUrl = new Map<string, FetchedSource>();
  for (let index = 0; index < candidates.length; index += 5) {
    const batch = candidates.slice(index, index + 5);
    const fetched = await Promise.all(batch.map(async (stored) => {
      const source = await sourceValidator.fetch({ title: stored.title, url: stored.url! }, signal);
      return source ? { storedUrl: stored.url!, source } : null;
    }));
    for (const item of fetched) {
      if (item) {
        fetchedSources.push(item.source);
        fetchedByStoredUrl.set(item.storedUrl, item.source);
      }
    }
  }
  const sources = await persistSources(runId, project, fetchedSources);
  return {
    sources,
    approvedClaims: approvedClaims.map((claim) => ({
      ...claim,
      url: fetchedByStoredUrl.get(claim.url ?? "")?.url ?? claim.url,
    })),
  };
}

function mergeSources(
  target: Map<string, { id: string; source: FetchedSource }>,
  additions: Map<string, { id: string; source: FetchedSource }>,
): void {
  for (const [url, value] of additions) {
    if (!target.has(url)) target.set(url, value);
  }
}

function validatedApprovedClaims(
  references: ApprovedClaimReference[],
  sourcesByUrl: Map<string, { id: string; source: FetchedSource }>,
): Array<{ reference: ApprovedClaimReference; source: FetchedSource; quote: string }> {
  const validated: Array<{ reference: ApprovedClaimReference; source: FetchedSource; quote: string }> = [];
  for (const reference of references) {
    const quote = exactQuoteFromMethodology(reference.methodology);
    const item = [...sourcesByUrl.values()].find((candidate) =>
      candidate.id === reference.sourceId || candidate.source.url === reference.url);
    if (!quote || !item) continue;
    const claim: ClaimExtraction = {
      claim: reference.claim,
      category: reference.category,
      claimType: "reported_claim",
      evidenceUrl: item.source.url,
      evidenceQuote: quote,
      relatedBrand: null,
      competitorName: null,
    };
    if (exactQuoteSupportsClaim(claim, item.source)) validated.push({ reference, source: item.source, quote });
  }
  return validated;
}

function sourceEvidence(sources: FetchedSource[]): string {
  return sources.filter((source) => source.accessible && source.text)
    .map((source) => `SOURCE URL: ${source.url}\nTITLE: ${source.title}\nPUBLISHER: ${source.publisher}\nPUBLISHED: ${source.publishedAt?.toISOString() ?? "undated"}\nCONTENT (untrusted): ${source.text}`)
    .join("\n\n--- SOURCE BOUNDARY ---\n\n").slice(0, 95_000);
}

async function discoverBrand(
  project: ProjectContext,
  sourceMap: Map<string, { id: string; source: FetchedSource }>,
  signal?: AbortSignal,
  exactOnly = false,
): Promise<Candidate[]> {
  const evidence = sourceEvidence([...sourceMap.values()].map(({ source }) => source));
  if (!evidence) return [];
  let extracted: { candidates: BrandExtraction[] };
  try {
    extracted = await llm.json(
      "Identify possible official brand/company identities matching the requested brand. Include only candidates directly evidenced by the cited pages. Return JSON exactly as {\"candidates\":[{\"name\":\"official brand name\",\"parent\":null,\"industry\":null,\"sourceUrl\":\"exact URL copied from a source\",\"evidenceQuote\":\"one exact contiguous quote from that official source that names the brand\",\"regionalEntity\":null,\"regionalEntityEvidenceQuote\":null}]}. sourceUrl must exactly match one source URL copied verbatim, including its full path and all query/tracking parameters; never shorten or normalize it. The evidenceQuote must be copied verbatim from that exact page and substantively identify the brand. Do not invent a website. Only populate regionalEntity when the same or another exact quote on an official source explicitly names a regional entity; provide its separate exact quote, otherwise set both regionalEntity fields null. For Talabat Mart, distinguish the Talabat company/brand from the Talabat Mart product when both are evidenced.",
      `Requested brand: ${project.clientName}; market: ${project.market}; product focus: ${project.productFocus ?? "not specified"}\n${evidence}`,
      brandExtractSchema,
      signal,
    );
  } catch (error) {
    logger.warn({
      researchProjectId: project.id,
      requestedBrand: project.clientName,
      accessibleSources: [...sourceMap.values()].filter(({ source }) => source.accessible && !!source.text).length,
      extractedCandidates: 0,
      acceptedCandidates: 0,
      rejectionCounts: { structured_candidate_extraction_failed: 1 },
      error: error instanceof Error ? error.message : "Unknown structured extraction error",
    }, "Brand candidate evidence review could not parse extraction");
    throw error;
  }
  const candidates: Candidate[] = [];
  const rejectionCounts: Record<string, number> = {};
  const reject = (reason: string) => {
    rejectionCounts[reason] = (rejectionCounts[reason] ?? 0) + 1;
  };
  for (const candidate of extracted.candidates) {
    const stored = sourceMap.get(candidate.sourceUrl);
    if (!stored) {
      reject("source_url_not_an_exact_citation");
      continue;
    }
    if (!stored.source.accessible || !stored.source.text) {
      reject("official_source_not_accessible");
      continue;
    }
    const sourceHost = hostname(stored.source.url);
    if (!sourceHost) {
      reject("official_source_invalid_host");
      continue;
    }
    const rejection = sourceBackedOfficialBrandEvidenceRejection({
      enteredName: project.clientName,
      candidateName: candidate.name,
      host: sourceHost,
      title: stored.source.title,
      sourceText: stored.source.text,
      evidenceQuote: candidate.evidenceQuote,
    });
    if (rejection) {
      reject(rejection);
      continue;
    }
    if (exactOnly && normalized(project.clientName) !== normalized(candidate.name)) {
      reject("exact_brand_match_not_found");
      continue;
    }
    const website = origin(candidate.sourceUrl);
    if (!website) {
      reject("official_website_not_https");
      continue;
    }
    const regionalQuoteValid = !!candidate.regionalEntity && !!candidate.regionalEntityEvidenceQuote &&
      stored.source.text.includes(candidate.regionalEntityEvidenceQuote) &&
      ` ${normalized(candidate.regionalEntityEvidenceQuote)} `.includes(` ${normalized(candidate.regionalEntity)} `);
    candidates.push({
      name: candidate.name,
      website,
      parent: candidate.parent,
      industry: candidate.industry,
      sourceUrl: candidate.sourceUrl,
      evidenceQuote: candidate.evidenceQuote,
      regionalEntity: regionalQuoteValid ? candidate.regionalEntity : null,
      regionalEntityEvidenceQuote: regionalQuoteValid ? candidate.regionalEntityEvidenceQuote : null,
    });
  }
  logger.info({
    researchProjectId: project.id,
    requestedBrand: project.clientName,
    exactMatchesOnly: exactOnly,
    accessibleSources: [...sourceMap.values()].filter(({ source }) => source.accessible && !!source.text).length,
    extractedCandidates: extracted.candidates.length,
    acceptedCandidates: candidates.length,
    rejectionCounts,
  }, "Brand candidate evidence review complete");
  return candidates.sort((left, right) =>
    Number(normalized(right.name) === normalized(project.clientName)) -
      Number(normalized(left.name) === normalized(project.clientName)));
}

async function recoverBrandFromOfficialTitles(
  runId: string,
  project: ProjectContext,
  sourceMap: Map<string, { id: string; source: FetchedSource }>,
  signal?: AbortSignal,
): Promise<Candidate[]> {
  // Earlier attempts may have fetched a useful about page that the latest
  // search omitted. Re-fetch it rather than relying on a stored snippet.
  const earlier = await db.select({ url: sourcesTable.url, title: sourcesTable.title })
    .from(sourcesTable).where(eq(sourcesTable.researchRunId, runId));
  const possible = earlier.filter((row) => row.url && !sourceMap.has(row.url) &&
    row.title.split(/\s+[|·–—]\s+/).some((part) =>
      part.toLowerCase().startsWith(`${project.clientName.toLowerCase()} `)))
    .slice(0, 6);
  const fetched = (await Promise.all(possible.map((row) =>
    sourceValidator.fetch({ url: row.url!, title: row.title }, signal))))
    .filter((source): source is FetchedSource => source !== null);
  mergeSources(sourceMap, await persistSources(runId, project, fetched));

  const candidates: Candidate[] = [];
  for (const { source } of sourceMap.values()) {
    if (!source.accessible || !source.text) continue;
    const host = hostname(source.url);
    if (!host) continue;
    const identity = officialBrandFromPageTitle({
      enteredName: project.clientName,
      host,
      title: source.title,
      sourceText: source.text,
    });
    if (!identity) continue;
    const website = origin(source.url);
    if (!website) continue;
    // Prefer an accessible, unnumbered www host on the same official domain
    // for the displayed website; the exact cited about page remains the evidence.
    const brandDomain = host.replace(/^www\d*\./, "");
    const regionalHomepage = [...sourceMap.values()].find(({ source: other }) =>
      other.accessible && !!other.text && hostname(other.url) === brandDomain);
    candidates.push({
      name: identity.name,
      website: regionalHomepage ? origin(regionalHomepage.source.url) ?? website : website,
      sourceUrl: source.url,
      evidenceQuote: identity.evidenceQuote,
      parent: null,
      industry: null,
      regionalEntity: null,
      regionalEntityEvidenceQuote: null,
    });
  }
  return [...new Map(candidates.map((candidate) =>
    [`${candidate.name.toLowerCase()}:${candidate.website}`, candidate])).values()];
}

async function runBrandResolution(runId: string, project: ProjectContext): Promise<void> {
  const controller = await claimQueuedRun(runId);
  if (!controller) return;
  try {
    await saveStage(runId, "brand_resolution", "running");
    const gathered = await gatherPlanned([
      `${project.clientName} official company website newsroom ${project.market}${project.productFocus ? ` ${project.productFocus}` : ""}`,
      `${project.clientName} ${project.market} company official about UAE business publication`,
      `${project.clientName} ${project.market} brand identity product company`,
    ], controller.signal);
    const sourceMap = await persistSources(runId, project, gathered.sources);
    let candidates = await discoverBrand(project, sourceMap, controller.signal, true);
    if (!candidates.length) {
      const likelySpellings = await llm.json(
        "Suggest at most four likely canonical spellings of the user's entered brand name to guide web searches only. Do not assert identity or invent facts; search results and accessible official sources will be independently required before any suggestion can be offered. Return JSON exactly as {\"spellings\":[\"...\" ]}.",
        `User-entered brand spelling: ${project.enteredBrandName ?? project.clientName}`,
        likelyBrandSpellingsSchema,
        controller.signal,
      );
      const spellingQueries = [...new Set(likelySpellings.spellings
        .filter((name) => isPlausibleBrandSpelling(project.clientName, name) &&
          normalized(name) !== normalized(project.clientName)))].slice(0, 3);
      const fallbackNames = spellingQueries.length ? spellingQueries : [project.clientName];
      const fallbackSearch = await gatherPlanned(fallbackNames.flatMap((name) => [
        `${name} official company website about`,
        `${name} official brand company ${project.market}`,
      ]), controller.signal);
      const fallbackSources = await persistSources(runId, project, fallbackSearch.sources);
      mergeSources(sourceMap, fallbackSources);
      candidates = await discoverBrand(project, sourceMap, controller.signal);
    }
    if (!candidates.length) {
      candidates = await recoverBrandFromOfficialTitles(runId, project, sourceMap, controller.signal);
    }
    if (!candidates.length) throw new Error("No source-supported brand candidates could be identified");
    await db.update(researchRunsTable).set({
      brandCandidates: candidates,
      status: "awaiting_brand_confirmation",
      stage: "brand_resolution",
      stages: updateStage((await loadRun(runId)).stages as RunStage[], "brand_resolution", "needs_review", "Confirm the correct brand and official website"),
    }).where(and(eq(researchRunsTable.id, runId), eq(researchRunsTable.status, "running")));
  } catch (error) {
    await saveStage(runId, "brand_resolution", "failed", error instanceof Error ? error.message : "Brand resolution failed");
    await markRunFailed(runId, error);
  } finally {
    activeRunIds.delete(runId);
    runControllers.delete(runId);
  }
}

export async function confirmBrand(project: ProjectContext, runId: string, website: string) {
  const run = await loadRun(runId);
  const candidate = (run.brandCandidates as Candidate[]).find((item) => item.website === website);
  if (!candidate) throw new Error("Website must match one of this run's confirmed brand candidates");
  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${"research-active:" + project.id}))`);
    const [current] = await tx.select().from(researchRunsTable).where(and(
      eq(researchRunsTable.id, runId),
      eq(researchRunsTable.projectId, project.id),
    )).limit(1);
    if (!current) throw new Error("Research run not found");
    const existingBrand = current.confirmedBrand as Candidate | null;
    if (existingBrand) {
      if (brandConfirmationAction(existingBrand.website, candidate.website) === "already_confirmed") {
        return { run: current, shouldStart: false };
      }
      throw new Error("A different brand has already been confirmed for this run");
    }
    if (current.status !== "awaiting_brand_confirmation") {
      throw new Error("Research run is not awaiting brand confirmation");
    }
    const [active] = await tx.select({ id: researchRunsTable.id }).from(researchRunsTable).where(and(
      eq(researchRunsTable.projectId, project.id),
      inArray(researchRunsTable.status, ["queued", "running"]),
    )).limit(1);
    if (active) throw new Error("A research run is already queued or running for this project");
    const [updated] = await tx.update(researchRunsTable).set({
      confirmedBrand: candidate,
      brand: candidate.name,
      scope: pitchFocusedScope,
      status: "queued",
      stage: "company_research",
      stages: updateStage(current.stages as RunStage[], "brand_resolution", "complete"),
      errorMessage: null,
    }).where(and(
      eq(researchRunsTable.id, runId),
      eq(researchRunsTable.projectId, project.id),
      eq(researchRunsTable.status, "awaiting_brand_confirmation"),
    )).returning();
    if (!updated) return { run: null, shouldStart: false };
    await tx.update(pitchProjectsTable).set({
      enteredBrandName: project.enteredBrandName ?? project.clientName,
      canonicalBrandName: candidate.name,
      officialWebsite: candidate.website,
      regionalEntity: candidate.regionalEntity ?? null,
      title: `${candidate.name} OOH Opportunity`,
    }).where(eq(pitchProjectsTable.id, project.id));
    return { run: updated, shouldStart: true };
  });
  if (!result.run) throw new Error("Research run is not awaiting brand confirmation");
  if (result.shouldStart) {
    const canonicalProject = { ...project, clientName: candidate.name };
    void runRemainingStages(runId, canonicalProject, candidate, [], pitchFocusedStages).catch((error: unknown) => {
      logger.error({ err: error, researchRunId: runId }, "Pitch-focused research failed");
      void markRunFailed(runId, error);
    });
  }
  return result.run;
}

async function runCompanyAndDiscovery(runId: string, project: ProjectContext, brand: Candidate): Promise<void> {
  const controller = await claimQueuedRun(runId);
  if (!controller) return;
  try {
    await saveStage(runId, "company_research", "running");
    const companySearch = await gatherPlanned([
      `${brand.name} official company products services newsroom ${project.market}`,
      `${brand.name} ${project.market} business developments products services UAE publication`,
      `${brand.name} ${project.market} marketing agency media owner case study`,
    ], controller.signal, brand.website);
    const companyMap = await persistSources(runId, project, companySearch.sources);
    const companyClaims = await extractAndSaveClaims(runId, project, companyMap, "company");
    await saveStage(runId, "company_research", companyClaims.length ? "complete" : "limited_evidence",
      companyClaims.length ? undefined : "No dated, source-supported company claims were identified");
  } catch (error) {
    logger.error({ err: error, researchRunId: runId }, "Company research stage failed");
    await saveStage(runId, "company_research", "failed", error instanceof Error ? error.message : "Company research failed");
  }
  try {
    await saveStage(runId, "competitor_discovery", "running");
    const competitorSearch = await gatherPlanned([
      `${brand.name} competitors ${project.category ?? "industry"} ${project.market}${project.productFocus ? ` ${project.productFocus}` : ""}`,
      `${brand.name} ${project.market} competitor landscape ${project.category ?? "industry"} UAE business publication`,
    ], controller.signal, brand.website);
    const competitorMap = await persistSources(runId, project, competitorSearch.sources);
    const evidence = sourceEvidence([...competitorMap.values()].map(({ source }) => source));
    const competitorBrandAliases = [brand.name, project.enteredBrandName];
    const competitors: CompetitorCandidate[] = evidence ? (await llm.json(
      `Identify up to 8 direct competitors relevant to ${project.market} and this product focus: ${project.productFocus ?? "none"}. Do not include the researched brand itself or its entered spelling (${competitorBrandAliases.join(" / ")}). Return JSON exactly as {"competitors":[{"name":"...","relevance":"...","sourceUrl":"exact URL from sources"}]}. Only include names explicitly supported by source text; each sourceUrl must match a provided source.`,
      evidence,
      competitorExtractSchema,
      controller.signal,
    )).competitors.filter((candidate) =>
      competitorMap.has(candidate.sourceUrl) &&
      !isSelfBrandCandidate(candidate.name, competitorBrandAliases))
      .map((candidate) => ({ ...candidate, selected: true })) : [];
    await saveStage(runId, "competitor_discovery", competitors.length ? "complete" : "limited_evidence", competitors.length ? undefined : "No source-supported competitor candidates found");
    const run = await loadRun(runId);
    await db.update(researchRunsTable).set({
      competitorCandidates: competitors,
      status: "awaiting_competitor_review",
      stage: "competitor_discovery",
      stages: updateStage(run.stages as RunStage[], "competitor_discovery", competitors.length ? "needs_review" : "needs_review", "Review the suggested competitors; add or remove names before continuing"),
    }).where(and(eq(researchRunsTable.id, runId), eq(researchRunsTable.status, "running")));
  } catch (error) {
    logger.error({ err: error, researchRunId: runId }, "Competitor discovery stage failed");
    await saveStage(runId, "competitor_discovery", "failed", error instanceof Error ? error.message : "Competitor discovery failed");
    const run = await loadRun(runId);
    await db.update(researchRunsTable).set({
      status: "awaiting_competitor_review",
      stage: "competitor_discovery",
      errorMessage: "Competitor discovery needs review; continue with user-selected competitors.",
    }).where(and(eq(researchRunsTable.id, runId), eq(researchRunsTable.status, "running")));
  } finally {
    activeRunIds.delete(runId);
    runControllers.delete(runId);
  }
}

async function extractAndSaveClaims(
  runId: string,
  project: ProjectContext,
  sourceMap: Map<string, { id: string; source: FetchedSource }>,
  group: "company" | "competitor" | "campaign" | "marketing" | "ooh",
  competitorName?: string,
): Promise<string[]> {
  const evidence = sourceEvidence([...sourceMap.values()].map(({ source }) => source));
  if (!evidence) return [];
  const extracted = await claimExtractor.extract(evidence, group, runControllers.get(runId)?.signal);
  const claimIds: string[] = [];
  for (const claim of extracted) {
    const evidenceSource = sourceMap.get(claim.evidenceUrl);
    const category = claim.category.startsWith(`${group}.`) ? claim.category : `${group}.overview`;
    if (!evidenceSource?.source.accessible || !evidenceSource.source.text ||
      !exactQuoteSupportsClaim(claim, evidenceSource.source) || claim.claimType === "estimate") {
      if (evidenceSource) {
        await markClaimNeedsReview(project.id, evidenceSource.id, claim.claim);
      }
      continue;
    }
    const source = evidenceSource.source;
    const regionalActivity = group === "marketing" || group === "campaign" || group === "ooh" ||
      (group === "competitor" && /recent|campaign|promotion|outdoor|ooh|dooh|transit/i.test(category));
    if (regionalActivity && (!isWithinRecentResearchWindow(source.publishedAt) ||
      !quoteExplicitlyLocatesInUae(claim.evidenceQuote))) {
      await markClaimNeedsReview(project.id, evidenceSource.id, claim.claim);
      continue;
    }
    const factualSupport = !!source.publishedAt && source.qualityScore >= 70;
    const relatedCampaignId = group === "campaign" || group === "ooh"
      ? (await db.select({ id: campaignsTable.id }).from(campaignsTable).where(and(
        eq(campaignsTable.projectId, project.id),
        or(eq(campaignsTable.sourceId, evidenceSource.id), arrayContains(campaignsTable.sourceIds, [evidenceSource.id])),
      )))[0]?.id ?? null
      : null;
    const claimId = await insertClaimOnce({
      projectId: project.id,
      researchRunId: runId,
      sourceId: evidenceSource.id,
      claim: claim.claim,
      category,
      relatedBrand: claim.relatedBrand ?? project.clientName,
      relatedCampaignId,
      relatedCompetitorId: null,
      methodology: `Source-exact excerpt: “${claim.evidenceQuote}”`,
      claimType: claim.claimType,
      isDemo: false,
      publishedAt: source.publishedAt,
      geography: quoteExplicitlyLocatesInUae(claim.evidenceQuote) ? project.market : "",
      confidence: factualSupport ? (source.qualityScore >= 90 ? "confirmed" : "strongly_indicated") : "estimated",
      status: factualSupport ? "approved" : "draft",
    });
    if (claimId) claimIds.push(claimId);
  }
  if (claimIds.length) {
    await db.update(researchRunsTable).set({
      claimsGenerated: sql`${researchRunsTable.claimsGenerated} + ${claimIds.length}`,
    }).where(eq(researchRunsTable.id, runId));
  }
  return claimIds;
}

async function insertClaimOnce(values: typeof researchClaimsTable.$inferInsert): Promise<string | null> {
  const sourceId = values.sourceId!;
  const [source] = await db.select({ url: sourcesTable.url }).from(sourcesTable).where(eq(sourcesTable.id, sourceId));
  const lockIdentity = source?.url ?? sourceId;
  const lockKey = `research-claim:${values.projectId}:${lockIdentity}:${normalized(values.claim ?? "")}`;
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);
    const existingRows = source?.url
      ? await tx.select({ id: researchClaimsTable.id, claim: researchClaimsTable.claim })
        .from(researchClaimsTable).innerJoin(sourcesTable, eq(researchClaimsTable.sourceId, sourcesTable.id))
        .where(and(eq(researchClaimsTable.projectId, values.projectId), eq(sourcesTable.url, source.url)))
      : await tx.select({ id: researchClaimsTable.id, claim: researchClaimsTable.claim })
        .from(researchClaimsTable).where(and(
          eq(researchClaimsTable.projectId, values.projectId),
          eq(researchClaimsTable.sourceId, sourceId),
        ));
    const existing = existingRows.find((row) => normalized(row.claim) === normalized(values.claim ?? ""));
    if (existing) {
      await tx.update(researchClaimsTable).set({
        methodology: values.methodology,
        confidence: values.confidence,
        status: values.status,
        publishedAt: values.publishedAt,
        claimType: values.claimType,
      }).where(eq(researchClaimsTable.id, existing.id));
      return null;
    }
    const [inserted] = await tx.insert(researchClaimsTable).values(values).returning({ id: researchClaimsTable.id });
    return inserted?.id ?? null;
  });
}

async function markClaimNeedsReview(projectId: string, sourceId: string, claim: string): Promise<void> {
  const [source] = await db.select({ url: sourcesTable.url }).from(sourcesTable).where(eq(sourcesTable.id, sourceId));
  const lockIdentity = source?.url ?? sourceId;
  const lockKey = `research-claim:${projectId}:${lockIdentity}:${normalized(claim)}`;
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);
    const existingRows = source?.url
      ? await tx.select({ id: researchClaimsTable.id, claim: researchClaimsTable.claim, methodology: researchClaimsTable.methodology })
        .from(researchClaimsTable).innerJoin(sourcesTable, eq(researchClaimsTable.sourceId, sourcesTable.id))
        .where(and(eq(researchClaimsTable.projectId, projectId), eq(sourcesTable.url, source.url)))
      : await tx.select({ id: researchClaimsTable.id, claim: researchClaimsTable.claim, methodology: researchClaimsTable.methodology })
        .from(researchClaimsTable).where(and(
          eq(researchClaimsTable.projectId, projectId),
          eq(researchClaimsTable.sourceId, sourceId),
        ));
    const existing = existingRows.filter((item) => normalized(item.claim) === normalized(claim));
    for (const item of existing) {
      if (item.methodology?.startsWith("Source-exact excerpt:")) continue;
      await tx.update(researchClaimsTable).set({
        confidence: "estimated",
        status: "draft",
        methodology: "Prior approval requires a verbatim source-exact passage; current evidence did not validate it.",
      }).where(eq(researchClaimsTable.id, item.id));
    }
  });
}

export async function confirmCompetitors(project: ProjectContext, runId: string, names: string[]) {
  const run = await loadRun(runId);
  if (run.status !== "awaiting_competitor_review" || run.projectId !== project.id) {
    throw new Error("Research run is not awaiting competitor review");
  }
  if (!run.confirmedBrand) throw new Error("Brand must be confirmed before competitor research");
  const uniqueNames = [...new Set(names.map((name) => name.trim()).filter(Boolean))].slice(0, 10);
  const continuationStages = stageKeys.slice(3);
  const continuationScope = run.scope.startsWith("retry:")
    ? `retry:${run.scope.slice("retry:".length).split(":")[0]}:${continuationStages.join(",")}`
    : run.scope;
  const claimed = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${"research-active:" + project.id}))`);
    const [active] = await tx.select({ id: researchRunsTable.id }).from(researchRunsTable).where(and(
      eq(researchRunsTable.projectId, project.id),
      inArray(researchRunsTable.status, ["queued", "running"]),
    )).limit(1);
    if (active) throw new Error("A research run is already queued or running for this project");
    const [updated] = await tx.update(researchRunsTable).set({
      scope: continuationScope,
      status: "queued",
      stage: "competitor_research",
      stages: (run.stages as RunStage[]).map((stage) => continuationStages.includes(stage.key as typeof continuationStages[number])
        ? { key: stage.key, status: "pending" as const }
        : stage),
      competitorCandidates: uniqueNames.map((name) => ({
        name,
        selected: true,
        relevance: (run.competitorCandidates as CompetitorCandidate[]).find((item) => normalized(item.name) === normalized(name))?.relevance ?? "Selected for this market by the project user.",
        sourceUrl: (run.competitorCandidates as CompetitorCandidate[]).find((item) => normalized(item.name) === normalized(name))?.sourceUrl ?? null,
      })),
      errorMessage: null,
    }).where(and(eq(researchRunsTable.id, runId), eq(researchRunsTable.status, "awaiting_competitor_review"))).returning();
    return updated;
  });
  if (!claimed) throw new Error("Research run is already being processed");
  void runRemainingStages(runId, project, run.confirmedBrand as Candidate, uniqueNames).catch((error: unknown) => {
    logger.error({ err: error, researchRunId: runId }, "Remaining research stages failed");
    void markRunFailed(runId, error);
  });
}

export async function startDeepResearch(project: ProjectContext, runId: string) {
  const run = await loadRun(runId);
  if (run.projectId !== project.id) throw new Error("Research run not found");
  if (!isEligibleQuickRunForDeepResearch({
    scope: run.scope,
    status: run.status,
    confirmedBrand: run.confirmedBrand,
    stages: run.stages as RunStage[],
  })) {
    throw new Error("Deep research can only start from a completed quick run with a confirmed brand; partial runs must contain limited-evidence stages");
  }
  const projectRuns = await db.select({ scope: researchRunsTable.scope }).from(researchRunsTable)
    .where(eq(researchRunsTable.projectId, project.id));
  const hasPriorDeepRun = projectRuns.some(({ scope }) => {
    if (!scope.startsWith(`retry:${runId}:`)) return false;
    return (selectedStagesFromRetryScope(scope) ?? []).some((stage) => deepResearchStages.has(stage));
  });
  if (hasPriorDeepRun) throw new Error("Deep research has already been started for this quick run");

  const retry = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${"research-active:" + project.id}))`);
    const [active] = await tx.select({ id: researchRunsTable.id }).from(researchRunsTable).where(and(
      eq(researchRunsTable.projectId, project.id),
      inArray(researchRunsTable.status, ["queued", "running"]),
    )).limit(1);
    if (active) throw new Error("A research run is already queued or running for this project");
    const [created] = await tx.insert(researchRunsTable).values({
      projectId: project.id,
      scope: `retry:${run.id}:competitor_discovery`,
      status: "queued",
      stage: "competitor_discovery",
      stages: (run.stages as RunStage[]).map((stage) => stage.key === "competitor_discovery"
        ? { key: stage.key, status: "pending" as const }
        : {
          ...stage,
          note: `Retained from prior run ${run.id}${stage.note ? `: ${stage.note}` : ""}`.slice(0, 500),
        }),
      brand: run.brand,
      lastAttemptedAt: new Date(),
      market: run.market,
      focus: run.focus,
      confirmedBrand: run.confirmedBrand,
      brandCandidates: run.brandCandidates,
      competitorCandidates: run.competitorCandidates,
    }).returning();
    return created;
  });
  if (!retry) throw new Error("Could not start deep research");
  void runRemainingStages(retry.id, project, run.confirmedBrand as Candidate, [], ["competitor_discovery"]).catch((error: unknown) => {
    logger.error({ err: error, researchRunId: retry.id }, "Deep research discovery failed");
    void markRunFailed(retry.id, error);
  });
  return await getRun(project.id, retry.id);
}

async function stageWork(runId: string, stage: string, selectedStages: ReadonlySet<string>, task: () => Promise<void>): Promise<void> {
  if (!selectedStages.has(stage)) return;
  await saveStage(runId, stage, "running");
  try {
    await task();
    const run = await loadRun(runId);
    if ((run.stages as RunStage[]).find((item) => item.key === stage)?.status === "running") {
      await saveStage(runId, stage, "complete");
    }
  } catch (error) {
    if (signalFor(runId)?.aborted) throw error;
    logger.error({ err: error, researchRunId: runId, stage }, "Research stage failed");
    await saveStage(runId, stage, "failed", error instanceof Error ? error.message : `${stage} failed`);
  }
}

async function saveCompetitorOnce(values: typeof competitorsTable.$inferInsert): Promise<string | null> {
  const lockKey = `research-competitor:${values.projectId}:${normalized(values.name ?? "")}`;
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);
    const projectRows = await tx.select().from(competitorsTable).where(eq(competitorsTable.projectId, values.projectId));
    const existing = projectRows.find((row) => normalized(row.name) === normalized(values.name ?? ""));
    if (!existing) {
      const [inserted] = await tx.insert(competitorsTable).values(values).returning({ id: competitorsTable.id });
      return inserted?.id ?? null;
    }
    const [updated] = await tx.update(competitorsTable).set({
      category: values.category,
      relevance: values.relevance,
      positioning: values.positioning,
      mainProducts: values.mainProducts,
      recentMarketing: values.recentMarketing,
      outdoorActivity: values.outdoorActivity,
      mainMessage: values.mainMessage,
      strengths: values.strengths,
      observableGaps: values.observableGaps,
      currentPromotion: values.currentPromotion,
      doohActivity: values.doohActivity,
      transitActivity: values.transitActivity,
      evidenceClaimIds: [...new Set([...(existing.evidenceClaimIds ?? []), ...(values.evidenceClaimIds ?? [])])],
    }).where(eq(competitorsTable.id, existing.id)).returning({ id: competitorsTable.id });
    return updated?.id ?? existing.id;
  });
}

async function saveStrategyDecisionOnce(values: typeof strategyDecisionsTable.$inferInsert): Promise<void> {
  const lockKey = `research-strategy:${values.projectId}:${values.researchRunId}:${values.decisionType}`;
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);
    const [existing] = await tx.select({ id: strategyDecisionsTable.id }).from(strategyDecisionsTable).where(and(
      eq(strategyDecisionsTable.projectId, values.projectId),
      eq(strategyDecisionsTable.researchRunId, values.researchRunId!),
      eq(strategyDecisionsTable.decisionType, values.decisionType!),
    ));
    if (existing) {
      await tx.update(strategyDecisionsTable).set({
        recommendation: values.recommendation,
        rationale: values.rationale,
        status: "draft",
        evidenceClaimIds: values.evidenceClaimIds,
        isDemo: false,
      }).where(eq(strategyDecisionsTable.id, existing.id));
      return;
    }
    await tx.insert(strategyDecisionsTable).values(values);
  });
}

const missingEvidenceByStrategyKey: Record<StrategyData["key"], string> = {
  why_now: "dated evidence of a current business, market, or customer trigger",
  business_trigger: "verified company or market evidence explaining why the business must act now",
  marketing_trigger: "source-exact evidence of recent marketing activity or a marketing objective",
  competitor_trigger: "approved source-exact evidence of a competitor action or change",
  ooh_gap: "verified OOH inventory, audience reach, competitor presence, or an evidenced coverage gap",
  audience: "verified evidence identifying the relevant audience and its needs or behavior",
  territory: "verified evidence supporting the proposed geography, locations, or territory",
  recommended_ooh: "verified audience, location, medium, or campaign evidence supporting an OOH recommendation",
  hypothesis: "approved claims that support a testable marketing or OOH hypothesis",
  white_space: "verified evidence of an unmet audience, market, or OOH opportunity",
};

async function runRemainingStages(
  runId: string,
  project: ProjectContext,
  brand: Candidate,
  competitorNames: string[],
  selectedKeys: string[] = stageKeys.slice(3),
): Promise<void> {
  const controller = await claimQueuedRun(runId);
  if (!controller) return;
  const selectedStages = new Set(selectedKeys);
  const sourcesByUrl = new Map<string, { id: string; source: FetchedSource }>();
  const campaignRecords: Array<{ data: CampaignData; sourceId: string; source: FetchedSource }> = [];
  let approvedClaims: ApprovedClaimReference[] = [];
  try {
    if (selectedStages.has("ai_synthesis") || selectedStages.has("strategy_generation")) {
      const inherited = await hydratePriorEvidence(
        runId,
        project,
        controller.signal,
        true,
      );
      mergeSources(sourcesByUrl, inherited.sources);
      approvedClaims = inherited.approvedClaims;
    }
    await stageWork(runId, "company_research", selectedStages, async () => {
      const result = await gatherPlanned([
        `${brand.name} official company products services newsroom ${project.market}`,
        `${brand.name} ${project.market} business developments products services UAE publication`,
        `${brand.name} ${project.market} agency media owner case study marketing`,
      ], controller.signal, brand.website);
      const saved = await persistSources(runId, project, result.sources);
      mergeSources(sourcesByUrl, saved);
      const claims = await extractAndSaveClaims(runId, project, saved, "company");
      if (!claims.length) {
        await saveStage(runId, "company_research", "limited_evidence", "No dated, source-exact company claims were identified");
      }
    });
    await stageWork(runId, "competitor_discovery", selectedStages, async () => {
      const result = await gatherPlanned([
        `${brand.name} competitors ${project.category ?? "industry"} ${project.market}${project.productFocus ? ` ${project.productFocus}` : ""}`,
        `${brand.name} ${project.market} competitor landscape ${project.category ?? "industry"} UAE business publication`,
      ], controller.signal, brand.website);
      const saved = await persistSources(runId, project, result.sources);
      const evidence = sourceEvidence([...saved.values()].map(({ source }) => source));
      const competitorBrandAliases = [brand.name, project.enteredBrandName];
      const candidates: CompetitorCandidate[] = evidence ? (await llm.json(
        `Identify up to 8 direct competitors relevant to ${project.market} and this product focus: ${project.productFocus ?? "none"}. Do not include the researched brand itself or its entered spelling (${competitorBrandAliases.join(" / ")}). Return JSON exactly as {"competitors":[{"name":"...","relevance":"...","sourceUrl":"exact URL from sources"}]}. Only include names explicitly supported by source text; each sourceUrl must match a provided source.`,
        evidence,
        competitorExtractSchema,
        controller.signal,
      )).competitors.filter((candidate) =>
        saved.has(candidate.sourceUrl) &&
        !isSelfBrandCandidate(candidate.name, competitorBrandAliases))
        .map((candidate) => ({ ...candidate, selected: true })) : [];
      const current = await loadRun(runId);
      await db.update(researchRunsTable).set({
        competitorCandidates: candidates,
        status: "awaiting_competitor_review",
        stage: "competitor_discovery",
        stages: updateStage(current.stages as RunStage[], "competitor_discovery", "needs_review",
          candidates.length ? "Review the suggested competitors; add or remove names before continuing" : "No source-supported competitors found; add any known competitors before continuing"),
      }).where(and(eq(researchRunsTable.id, runId), eq(researchRunsTable.status, "running")));
    });
    if (selectedStages.has("competitor_discovery")) return;
    await stageWork(runId, "competitor_research", selectedStages, async () => {
      for (const name of competitorNames) {
        const result = await gatherPlanned([
          `${name} official newsroom products positioning ${project.market}${project.productFocus ? ` ${project.productFocus}` : ""}`,
          `${name} ${project.market} recent marketing agency campaign media owner case study UAE publication`,
          `${name} ${project.market} official social campaign promotion event`,
        ], controller.signal);
        const saved = await persistSources(runId, project, result.sources);
        mergeSources(sourcesByUrl, saved);
        const ids = await extractAndSaveClaims(runId, project, saved, "competitor", name);
        const evidence = sourceEvidence([...saved.values()].map(({ source }) => source));
        let analysis: CompetitorAnalysis | undefined;
        if (evidence) {
          const response = await llm.json(
            `Return JSON exactly as {"competitors":[{"name":"${name}","positioning":null,"mainProducts":null,"recentMarketing":null,"outdoorActivity":null,"mainMessage":null,"strengths":null,"observableGaps":null,"currentPromotion":null,"doohActivity":null,"transitActivity":null,"evidenceUrls":[]}]}. Use only direct source support. Every evidenceUrls item must exactly match a source URL. UAE-specific recent marketing, outdoor, DOOH, transit, and promotion fields require a cited source passage explicitly naming the UAE or a UAE emirate/city; the search query is not evidence of geography. Leave fields null where unsupported. Current promotion is allowed only when explicitly dated within the last 90 days.`,
            evidence,
            competitorAnalysisSchema,
            controller.signal,
          );
          analysis = response.competitors.find((item) => normalized(item.name) === normalized(name));
        }
        const hasUaeRecentEvidence = !!analysis?.evidenceUrls.some((url) => {
          const source = saved.get(url)?.source;
          return isWithinRecentResearchWindow(source?.publishedAt) &&
            quoteExplicitlyLocatesInUae(source?.text);
        });
        const hasDatedCurrentEvidence = !!analysis?.currentPromotion && hasUaeRecentEvidence && analysis.evidenceUrls.some((url) => {
          const source = saved.get(url)?.source;
          return !!source?.publishedAt &&
            source.publishedAt.getTime() >= Date.now() - 90 * 86400000 &&
            source.publishedAt.getTime() <= Date.now() + 86400000;
        });
        const evidenceClaimIds = ids;
        const competitorRecordId = await saveCompetitorOnce({
          projectId: project.id,
          researchRunId: runId,
          name,
          category: project.category,
          relevance: (await loadRun(runId)).competitorCandidates.find((item) => normalized(item.name) === normalized(name))?.relevance ?? null,
          positioning: analysis?.positioning ?? null,
          mainProducts: analysis?.mainProducts ?? null,
          recentMarketing: hasUaeRecentEvidence ? analysis?.recentMarketing ?? null : null,
          outdoorActivity: hasUaeRecentEvidence ? analysis?.outdoorActivity ?? null : null,
          mainMessage: analysis?.mainMessage ?? null,
          strengths: analysis?.strengths ?? null,
          observableGaps: analysis?.observableGaps ?? null,
          currentPromotion: hasDatedCurrentEvidence ? analysis?.currentPromotion ?? null : null,
          doohActivity: hasUaeRecentEvidence ? analysis?.doohActivity ?? null : null,
          transitActivity: hasUaeRecentEvidence ? analysis?.transitActivity ?? null : null,
          evidenceClaimIds,
          isDemo: false,
        });
        if (competitorRecordId && ids.length) {
          await db.update(researchClaimsTable).set({ relatedCompetitorId: competitorRecordId })
            .where(inArray(researchClaimsTable.id, ids));
        }
      }
      if (!competitorNames.length) {
        await saveStage(runId, "competitor_research", "limited_evidence", "No competitors were selected for research");
      }
    });
    await stageWork(runId, "recent_marketing", selectedStages, async () => {
      const result = await gatherPlanned([
        `${brand.name} UAE recent marketing campaign product launch promotion in the last 6 months ${project.productFocus ?? ""} official newsroom`,
        `${brand.name} UAE recent advertising agency campaign media owner case study last 6 months`,
        `${brand.name} UAE recent digital social retail campaign promotion event last 6 months`,
      ], controller.signal, brand.website);
      const saved = await persistSources(runId, project, result.sources.filter((source) => isWithinRecentResearchWindow(source.publishedAt)));
      mergeSources(sourcesByUrl, saved);
      const claims = await extractAndSaveClaims(runId, project, saved, "marketing");
      if (!claims.length) await saveStage(runId, "recent_marketing", "limited_evidence", "No source-supported UAE marketing activity published in the last six months was identified");
    });
    await stageWork(runId, "campaign_research", selectedStages, async () => {
      const campaignCountBefore = campaignRecords.length;
      const queries = [
        `${brand.name} named campaign advertising UAE published in the last 6 months official newsroom ${project.productFocus ?? ""}`,
        `${brand.name} UAE campaign agency media owner case study published in the last 6 months`,
        `${brand.name} UAE campaign publication event social retail published in the last 6 months`,
      ];
      const result = await gatherPlanned(queries, controller.signal, brand.website);
      const saved = await persistSources(runId, project, result.sources.filter((source) => isWithinRecentResearchWindow(source.publishedAt)));
      mergeSources(sourcesByUrl, saved);
      const evidence = sourceEvidence([...saved.values()].map(({ source }) => source));
      if (evidence) {
        const extracted = await llm.json(
          "Return JSON exactly as {\"campaigns\":[{\"name\":\"...\",\"brandOrProduct\":null,\"productFocus\":null,\"startDate\":null,\"endDate\":null,\"geography\":null,\"message\":null,\"medium\":null,\"location\":null,\"evidenceUrl\":\"exact source URL\",\"evidenceQuote\":\"exact contiguous source sentence of at most 500 characters naming this campaign\",\"evidenceStatus\":\"insufficient_evidence\"}]}. Extract named brand or product campaigns clearly described by source text. evidenceQuote is required and must be verbatim, name the campaign, and include any date or medium asserted. Only supply dates explicitly stated in that same sentence; never use unrelated dates or <time> metadata. Only supply a recognized medium when named in that same sentence; otherwise set it null. Mark confirmed_ooh only when that sentence explicitly documents a specific out-of-home format or placement.",
          evidence,
          campaignsSchema,
          controller.signal,
        );
        for (const campaign of extracted.campaigns) {
          const item = saved.get(campaign.evidenceUrl);
          const validated = item ? validateCampaignEvidence(campaign, item.source) : null;
          if (item && validated) campaignRecords.push({ data: validated, sourceId: item.id, source: item.source });
        }
      }
      if (campaignRecords.length === campaignCountBefore) {
        await saveStage(runId, "campaign_research", "limited_evidence", "No source-validated campaign was identified");
      }
      if (campaignRecords.length > campaignCountBefore) await saveCampaigns(runId, project, brand, campaignRecords.slice(campaignCountBefore));
    });
    await stageWork(runId, "ooh_research", selectedStages, async () => {
      const campaignCountBefore = campaignRecords.length;
      const result = await gatherPlanned([
        `${brand.name} UAE OOH DOOH billboard transit airport campaign published in the last 6 months`,
        `${brand.name} UAE media owner outdoor advertising case study published in the last 6 months`,
        `${brand.name} UAE OOH DOOH transit campaign agency publication last 6 months`,
      ], controller.signal, brand.website);
      const saved = await persistSources(runId, project, result.sources.filter((source) => isWithinRecentResearchWindow(source.publishedAt)));
      mergeSources(sourcesByUrl, saved);
      const evidence = sourceEvidence([...saved.values()].map(({ source }) => source));
      if (!evidence) {
        await saveStage(runId, "ooh_research", "limited_evidence", "No accessible source text was found for OOH research");
        return;
      }
      const extracted = await llm.json(
        "Return JSON exactly as {\"campaigns\":[{\"name\":\"...\",\"brandOrProduct\":null,\"productFocus\":null,\"startDate\":null,\"endDate\":null,\"geography\":null,\"message\":null,\"medium\":null,\"location\":null,\"evidenceUrl\":\"exact source URL\",\"evidenceQuote\":\"exact contiguous source sentence of at most 500 characters describing the campaign medium\",\"evidenceStatus\":\"insufficient_evidence\"}]}. Identify only named campaigns with explicit out-of-home evidence in these sources. The campaign name must appear in the exact source quote OR the fetched page title; if only the title names the campaign, the source quote must explicitly describe a specific format or placement (not just generic outdoor/OOH). evidenceQuote must be verbatim and contiguous. Only supply dates stated in that same quoted sentence. Never infer a medium or location. Set unknown fields null.",
        evidence,
        campaignsSchema,
        controller.signal,
      );
      for (const campaign of extracted.campaigns) {
        const item = saved.get(campaign.evidenceUrl);
        const validated = item ? validateCampaignEvidence(campaign, item.source) : null;
        if (item && validated) campaignRecords.push({ data: validated, sourceId: item.id, source: item.source });
      }
      if (!campaignRecords.slice(campaignCountBefore).some((record) =>
        record.data.evidenceStatus !== "insufficient_evidence" && !!record.data.medium)) {
        const fallback = await gatherPlanned([
          `${brand.name} UAE recent digital social retail campaign promotion in the last 6 months`,
          `${brand.name} UAE recent social media product launch offer event last 6 months`,
        ], controller.signal, brand.website);
        const fallbackSources = await persistSources(
          runId,
          project,
          fallback.sources.filter((source) => isWithinRecentResearchWindow(source.publishedAt)),
        );
        mergeSources(sourcesByUrl, fallbackSources);
        if (fallbackSources.size) {
          const fallbackClaims = await extractAndSaveClaims(runId, project, fallbackSources, "marketing");
          if (fallbackClaims.length) {
            await saveStage(runId, "recent_marketing", "complete",
              "Recent UAE digital, social, or retail activity is available; no verified recent OOH placement was found");
          }
        }
        await saveStage(runId, "ooh_research", "limited_evidence", "No source-validated OOH campaign was identified");
      }
      if (campaignRecords.length > campaignCountBefore) await saveCampaigns(runId, project, brand, campaignRecords.slice(campaignCountBefore));
    });
    await stageWork(runId, "current_promotion", selectedStages, async () => {
      const promotionCountBefore = campaignRecords.length;
      const isCurrent = () => campaignRecords.some((record) => currentDated(record.source, record.data));
      if (!isCurrent()) {
        const result = await gatherPlanned([
          `${brand.name} UAE current or latest promotion offer sale active dates published in the last 6 months ${project.productFocus ?? ""} official`,
          `${brand.name} UAE current promotion recent offer social retail event last 6 months`,
        ], controller.signal, brand.website);
        const saved = await persistSources(runId, project, result.sources.filter((source) => isWithinRecentResearchWindow(source.publishedAt)));
        mergeSources(sourcesByUrl, saved);
        const evidence = sourceEvidence([...saved.values()].map(({ source }) => source));
        if (evidence) {
          const extracted = await llm.json(
            "Return JSON exactly as {\"campaigns\":[{\"name\":\"...\",\"brandOrProduct\":null,\"productFocus\":null,\"startDate\":null,\"endDate\":null,\"geography\":null,\"message\":null,\"medium\":null,\"location\":null,\"evidenceUrl\":\"exact source URL\",\"evidenceQuote\":\"exact contiguous source sentence of at most 500 characters naming this campaign\",\"evidenceStatus\":\"insufficient_evidence\"}]}. Return only campaigns with clear valid start and end dates stated in the exact same campaign-naming sentence. Any medium must also be named in that sentence. Do not use unrelated page dates or metadata.",
            evidence,
            campaignsSchema,
            controller.signal,
          );
          for (const campaign of extracted.campaigns) {
            const item = saved.get(campaign.evidenceUrl);
            const validated = item ? validateCampaignEvidence(campaign, item.source) : null;
            if (item && validated) campaignRecords.push({ data: validated, sourceId: item.id, source: item.source });
          }
          if (campaignRecords.length) await saveCampaigns(runId, project, brand, campaignRecords);
        }
      }
      if (!isCurrent()) {
        const latestDatedPromotion = campaignRecords.slice(promotionCountBefore).some((record) =>
          !!record.data.startDate && !!record.data.endDate && isWithinRecentResearchWindow(record.source.publishedAt));
        await saveStage(runId, "current_promotion", latestDatedPromotion ? "complete" : "limited_evidence",
          latestDatedPromotion
            ? "Latest dated promotion found; no currently active offer was verified"
            : "No current or recent dated promotion supported by a source published in the last six months was identified");
      }
    });
    await stageWork(runId, "source_validation", selectedStages, async () => {
      const storedSources = await db.select({ id: sourcesTable.id }).from(sourcesTable)
        .where(eq(sourcesTable.researchRunId, runId));
      await db.update(researchRunsTable).set({ sourcesFound: storedSources.length }).where(eq(researchRunsTable.id, runId));
    });
    await stageWork(runId, "ai_synthesis", selectedStages, async () => {
      if (!sourcesByUrl.size) {
        await saveStage(runId, "ai_synthesis", "limited_evidence", "No previously fetched, validated source evidence was available");
        return;
      }
      await saveCampaigns(runId, project, brand, campaignRecords);
      const campaignSourceRows = await db.select({
        sourceId: campaignsTable.sourceId,
        sourceIds: campaignsTable.sourceIds,
      }).from(campaignsTable).where(eq(campaignsTable.projectId, project.id));
      const campaignSourceIds = new Set(campaignSourceRows.flatMap((campaign) =>
        [campaign.sourceId, ...(campaign.sourceIds ?? [])].filter((sourceId): sourceId is string => !!sourceId)));
      const campaignSourceUrls = new Set((await db.select({ url: sourcesTable.url }).from(sourcesTable)
        .innerJoin(campaignsTable, or(
          eq(campaignsTable.sourceId, sourcesTable.id),
          sql`${sourcesTable.id} = ANY(${campaignsTable.sourceIds})`,
        )).where(eq(campaignsTable.projectId, project.id)))
        .map((source) => source.url).filter((url): url is string => !!url));
      for (const group of ["competitor", "campaign", "marketing", "ooh"] as const) {
        const relevant = new Map([...sourcesByUrl].filter(([, value]) => {
          if (!value.source.accessible || !value.source.text) return false;
          if (group === "campaign" || group === "ooh") return campaignSourceIds.has(value.id) ||
            campaignSourceUrls.has(value.source.url) ||
            campaignRecords.some((campaign) => campaign.sourceId === value.id);
          return true;
        }));
        if (relevant.size) await extractAndSaveClaims(runId, project, relevant, group);
      }
    });
    await stageWork(runId, "strategy_generation", selectedStages, async () => {
      if (!sourcesByUrl.size) {
        const run = await loadRun(runId);
        if (!run.scope.startsWith("retry:")) {
          const result = await gather(`${brand.name} company and market strategy evidence ${project.market}`, controller.signal);
          const saved = await persistSources(runId, project, result.sources);
          mergeSources(sourcesByUrl, saved);
        }
      }
      const evidenceSources = [...sourcesByUrl.values()].filter(({ source }) => source.accessible && source.text && source.publishedAt);
      const approvedClaimIdsByUrl = new Map<string, string[]>();
      const verifiedApprovedClaims = validatedApprovedClaims(approvedClaims, sourcesByUrl).slice(0, 30);
      for (const { reference, source } of verifiedApprovedClaims) {
        approvedClaimIdsByUrl.set(source.url, [
          ...(approvedClaimIdsByUrl.get(source.url) ?? []),
          reference.id,
        ]);
      }
      const approvedEvidenceText = verifiedApprovedClaims.map(({ reference, source, quote }) =>
        `APPROVED PROJECT CLAIM: ${reference.claim}\nSOURCE URL: ${source.url}\nEXACT SOURCE QUOTE: ${quote}`);
      const datedEvidence = sourceEvidence(evidenceSources.map(({ source }) => source));
      const evidence = [...approvedEvidenceText, datedEvidence].filter(Boolean).join("\n\n");
      if (!evidence) {
        await saveStage(runId, "strategy_generation", "limited_evidence", "Strategy requires dated source evidence or a revalidated approved project claim");
        return;
      }
      const result = await strategySynthesizer.synthesize(evidence, controller.signal);
      const savedClaims = await extractAndSaveSynthesisClaims(runId, project, result.claims, sourcesByUrl);
      for (const [url, ids] of approvedClaimIdsByUrl) {
        savedClaims.set(url, [...new Set([...(savedClaims.get(url) ?? []), ...ids])]);
      }
      let unsupportedSections = 0;
      for (const decision of result.strategy) {
        const candidateIds = [...new Set(decision.evidenceUrls.flatMap((url) => savedClaims.get(url) ?? []))];
        const approvedRows = candidateIds.length
          ? await db.select({
            id: researchClaimsTable.id,
            methodology: researchClaimsTable.methodology,
          }).from(researchClaimsTable).where(and(
            inArray(researchClaimsTable.id, candidateIds),
            eq(researchClaimsTable.status, "approved"),
            eq(researchClaimsTable.isDemo, false),
          ))
          : [];
        const evidenceClaimIds = approvedRows
          .filter((claim) => claim.methodology?.startsWith("Source-exact excerpt:"))
          .map((claim) => claim.id);
        const supported = evidenceClaimIds.length > 0;
        if (!supported) unsupportedSections += 1;
        await saveStrategyDecisionOnce({
          projectId: project.id,
          researchRunId: runId,
          decisionType: decision.key,
          recommendation: {
            text: supported
              ? decision.recommendation
              : "Insufficient evidence to recommend a direction yet.",
          },
          rationale: supported
            ? decision.rationale
            : `Missing evidence: ${missingEvidenceByStrategyKey[decision.key]}. No approved, source-exact claim supports this section yet.`,
          status: "draft",
          evidenceClaimIds: supported ? evidenceClaimIds : [],
          isDemo: false,
        });
      }
      if (unsupportedSections) {
        await saveStage(
          runId,
          "strategy_generation",
          "limited_evidence",
          `${unsupportedSections} required strategy section(s) lack approved source-exact evidence`,
        );
      }
    });
    const final = await loadRun(runId);
    const stages = final.stages as RunStage[];
    const failures = stages.filter((stage) => stage.status === "failed");
    const limited = stages.filter((stage) => stage.status === "limited_evidence");
    const hasSupportedClaims = final.claimsGenerated > 0 ||
      validatedApprovedClaims(approvedClaims, sourcesByUrl).length > 0;
    const partial = failures.length > 0 || limited.length > 0 || !hasSupportedClaims;
    const lastSelectedStage = [...selectedStages].at(-1) ?? "strategy_generation";
    const completedAt = new Date();
    let coverageSnapshot: Record<string, unknown> | null = null;
    try {
      coverageSnapshot = await buildCoverageSnapshot(project, runId, completedAt) as Record<string, unknown>;
    } catch (snapshotError) {
      logger.warn({ err: snapshotError, researchRunId: runId }, "Could not capture completed-run coverage snapshot");
    }
    await db.update(researchRunsTable).set({
      scope: final.scope === pitchFocusedScope ? "live_research_v1" : final.scope,
      status: partial ? "partial_success" : "completed",
      stage: lastSelectedStage,
      stages,
      completedAt,
      coverageSnapshot,
      coverageSnapshotAt: coverageSnapshot ? completedAt : null,
      coverageSnapshotStatus: coverageSnapshot ? "captured_at_completion" : "unavailable",
      errorMessage: failures.length
        ? `${failures.length} research stage(s) failed`
        : limited.length ? `${limited.length} research stage(s) have limited evidence`
          : !hasSupportedClaims ? "No supported research claims were generated" : null,
    }).where(and(eq(researchRunsTable.id, runId), eq(researchRunsTable.status, "running")));
  } finally {
    activeRunIds.delete(runId);
    runControllers.delete(runId);
  }
}

async function extractAndSaveSynthesisClaims(
  runId: string,
  project: ProjectContext,
  claims: ClaimExtraction[],
  sourcesByUrl: Map<string, { id: string; source: FetchedSource }>,
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  for (const claim of claims) {
    const item = sourcesByUrl.get(claim.evidenceUrl);
    const category = claim.category.startsWith("market.") ? claim.category : `market.${claim.category}`;
    if (!item?.source.accessible || !item.source.text || !exactQuoteSupportsClaim(claim, item.source) || claim.claimType === "estimate") {
      if (item) await markClaimNeedsReview(project.id, item.id, claim.claim);
      continue;
    }
    const factualSupport = !!item.source.publishedAt && item.source.qualityScore >= 70;
    const savedId = await insertClaimOnce({
      projectId: project.id,
      researchRunId: runId,
      sourceId: item.id,
      claim: claim.claim,
      category,
      relatedBrand: claim.relatedBrand ?? project.clientName,
      relatedCompetitorId: null,
      relatedCampaignId: null,
      methodology: `Source-exact excerpt: “${claim.evidenceQuote}”`,
      claimType: claim.claimType,
      isDemo: false,
      publishedAt: item.source.publishedAt,
      geography: project.market,
      confidence: factualSupport ? (item.source.qualityScore >= 90 ? "confirmed" : "strongly_indicated") : "estimated",
      status: factualSupport ? "approved" : "draft",
    });
    if (!savedId) continue;
    result.set(claim.evidenceUrl, [...(result.get(claim.evidenceUrl) ?? []), savedId]);
  }
  if (result.size) {
    const generated = [...result.values()].reduce((total, ids) => total + ids.length, 0);
    await db.update(researchRunsTable).set({ claimsGenerated: sql`${researchRunsTable.claimsGenerated} + ${generated}` })
      .where(eq(researchRunsTable.id, runId));
  }
  return result;
}

async function saveCampaigns(
  runId: string,
  project: ProjectContext,
  brand: Candidate,
  records: Array<{ data: CampaignData; sourceId: string; source: FetchedSource }>,
): Promise<void> {
  for (const record of records) {
    const data = record.data;
    const dedupeKey = campaignDedupeKey(data, brand.name, project.market);
    const current = currentDated(record.source, data);
    const values = {
      projectId: project.id,
      researchRunId: runId,
      dedupeKey,
      evidenceStatus: data.evidenceStatus,
      name: data.name,
      brandOrProduct: data.brandOrProduct ?? brand.name,
      productFocus: data.productFocus ?? project.productFocus,
      startDate: data.startDate,
      endDate: data.endDate,
      geography: data.geography,
      message: data.message,
      evidenceQuote: data.evidenceQuote,
      medium: data.medium,
      location: data.location,
      sourceId: record.sourceId,
      sourceIds: [record.sourceId],
      isCurrent: current,
      confidence: record.source.qualityScore >= 90 && record.source.publishedAt && data.startDate && data.endDate &&
        data.evidenceStatus !== "insufficient_evidence" ? "confirmed" as const :
        record.source.publishedAt && data.evidenceStatus !== "insufficient_evidence" ? "strongly_indicated" as const : "estimated" as const,
      isDemo: false,
    };
    await db.insert(campaignsTable).values(values).onConflictDoUpdate({
      target: [campaignsTable.projectId, campaignsTable.dedupeKey],
      set: {
        sourceIds: sql`ARRAY(SELECT DISTINCT source_id FROM unnest(
          ${campaignsTable.sourceIds} || ARRAY[${record.sourceId}]::uuid[] ||
          CASE WHEN ${campaignsTable.sourceId} IS NULL
            THEN ARRAY[]::uuid[] ELSE ARRAY[${campaignsTable.sourceId}] END
        ) AS source_list(source_id))`,
        evidenceStatus: values.evidenceStatus,
        name: values.name,
        brandOrProduct: values.brandOrProduct,
        productFocus: values.productFocus,
        startDate: values.startDate,
        endDate: values.endDate,
        sourceId: values.sourceId,
        medium: values.medium,
        location: values.location,
        geography: values.geography,
        message: values.message,
        evidenceQuote: values.evidenceQuote,
        confidence: values.confidence,
        isCurrent: current,
      },
    });
  }
}

const evidenceGapRetryStages = new Set([
  "company_research", "competitor_research", "recent_marketing",
  "campaign_research", "ooh_research", "current_promotion",
]);

async function stageHasEvidenceGap(project: ProjectContext, runId: string, stage: string): Promise<boolean> {
  const lineageIds = new Set<string>([runId]);
  let current = await loadRun(runId);
  while (current.scope.startsWith("retry:")) {
    const parentId = current.scope.slice("retry:".length).split(":")[0];
    if (!parentId || lineageIds.has(parentId)) break;
    lineageIds.add(parentId);
    current = await loadRun(parentId);
  }
  const lineage = [...lineageIds];
  if (stage === "campaign_research" || stage === "ooh_research" || stage === "current_promotion") {
    const campaigns = await db.select({
      name: campaignsTable.name,
      startDate: campaignsTable.startDate,
      endDate: campaignsTable.endDate,
      location: campaignsTable.location,
      evidenceStatus: campaignsTable.evidenceStatus,
      medium: campaignsTable.medium,
      isCurrent: campaignsTable.isCurrent,
      sourceUrl: sourcesTable.url,
      sourcePublisher: sourcesTable.publisher,
      sourcePublishedAt: sourcesTable.publishedAt,
      sourceQuality: sourcesTable.qualityScore,
    }).from(campaignsTable).innerJoin(sourcesTable, eq(campaignsTable.sourceId, sourcesTable.id)).where(and(
      eq(campaignsTable.projectId, project.id),
      eq(campaignsTable.isDemo, false),
      inArray(campaignsTable.researchRunId, lineage),
    ));
    const sourceBacked = campaigns.filter((campaign) => !!campaign.name && !!campaign.sourceUrl &&
      !!campaign.sourcePublisher && !!campaign.sourcePublishedAt && (campaign.sourceQuality ?? 0) >= 70);
    if (stage === "campaign_research") {
      // Campaign mentions alone are not coverage: allow targeted retries to
      // fill date/location fields while the campaign set still lacks them.
      return !sourceBacked.length ||
        !sourceBacked.some((campaign) => !!campaign.startDate && !!campaign.endDate) ||
        !sourceBacked.some((campaign) => !!campaign.location?.trim());
    }
    if (stage === "ooh_research") return !campaigns.some((campaign) =>
      campaign.evidenceStatus !== "insufficient_evidence" && !!campaign.medium &&
      !!campaign.sourceUrl && !!campaign.sourcePublishedAt && (campaign.sourceQuality ?? 0) >= 70);
    return !sourceBacked.some((campaign) => campaign.isCurrent);
  }
  const claims = await db.select({
    id: researchClaimsTable.id,
    researchRunId: researchClaimsTable.researchRunId,
    category: researchClaimsTable.category,
    status: researchClaimsTable.status,
    methodology: researchClaimsTable.methodology,
    relatedCompetitorId: researchClaimsTable.relatedCompetitorId,
    sourceUrl: sourcesTable.url,
    sourcePublishedAt: sourcesTable.publishedAt,
    sourceQuality: sourcesTable.qualityScore,
    isDemo: researchClaimsTable.isDemo,
  }).from(researchClaimsTable).innerJoin(sourcesTable, eq(researchClaimsTable.sourceId, sourcesTable.id)).where(and(
    eq(researchClaimsTable.projectId, project.id),
    inArray(researchClaimsTable.researchRunId, lineage),
  ));
  const approvedSourceBacked = claims.filter((claim) => !claim.isDemo && claim.status === "approved" &&
    claim.methodology?.startsWith("Source-exact excerpt:") && !!claim.sourceUrl &&
    !!claim.sourcePublishedAt && (claim.sourceQuality ?? 0) >= 70);
  const hasCategory = (items: typeof approvedSourceBacked, ...patterns: RegExp[]) =>
    items.some((claim) => patterns.some((pattern) => pattern.test(claim.category.toLowerCase())));
  if (stage === "company_research") {
    const required = [
      "company.overview", "company.business_model", "company.products", "company.key_markets",
      "company.target_audience", "company.positioning", "company.developments",
    ];
    return required.some((category) => !approvedSourceBacked.some((claim) =>
      claim.category.toLowerCase().includes(category)));
  }
  if (stage === "competitor_research") {
    const run = await loadRun(runId);
    const selectedNames = (run.competitorCandidates as CompetitorCandidate[])
      .filter((candidate) => candidate.selected).map((candidate) => normalized(candidate.name));
    if (!selectedNames.length) return false;
    const competitorRows = await db.select({
      id: competitorsTable.id,
      name: competitorsTable.name,
      evidenceClaimIds: competitorsTable.evidenceClaimIds,
    }).from(competitorsTable).where(eq(competitorsTable.projectId, project.id));
    const byName = new Map(competitorRows.map((competitor) => [normalized(competitor.name), competitor]));
    const needsResearch = (name: string) => {
      const competitor = byName.get(name);
      if (!competitor) return true;
      const linkedClaims = approvedSourceBacked.filter((claim) =>
        claim.relatedCompetitorId === competitor.id || competitor.evidenceClaimIds.includes(claim.id));
      return !hasCategory(linkedClaims, /official_identity|official_profile|competitor\.identity/) ||
        !hasCategory(linkedClaims, /uae_presence|united_arab_emirates/) ||
        !hasCategory(linkedClaims, /competitor\.category/) ||
        !hasCategory(linkedClaims, /competitor\.(?:products|main_products)|product(?:s)?/) ||
        !hasCategory(linkedClaims, /competitor\.positioning|positioning/) ||
        !hasCategory(linkedClaims, /recent_activity|recent_marketing|competitor\.campaign|competitor\.promotion/);
    };
    return selectedNames.some(needsResearch);
  }
  if (stage === "recent_marketing") {
    return !hasCategory(approvedSourceBacked, /marketing\.(?:recent_activity|campaign|promotion|product_launch)/);
  }
  return false;
}

export async function retryRunStages(project: ProjectContext, runId: string, requestedStages: string[]) {
  const run = await loadRun(runId);
  if (run.projectId !== project.id) throw new Error("Research run not found");
  const allowed = new Set(stageKeys);
  const chosen = [...new Set(requestedStages.filter((stage) => allowed.has(stage as typeof stageKeys[number])))];
  if (!chosen.length) throw new Error("No recognized research stages were requested");
  if (run.status === "running" || run.status === "queued") throw new Error("Research run is already processing");
  const previousStages = run.stages as RunStage[];
  const retryable = new Set(previousStages
    .filter((stage) => stage.status === "failed" || stage.status === "limited_evidence")
    .map((stage) => stage.key));
  const selected: string[] = [];
  for (const stage of chosen) {
    if (retryable.has(stage)) {
      selected.push(stage);
      continue;
    }
    const previous = previousStages.find((item) => item.key === stage);
    if (evidenceGapRetryStages.has(stage) && previous?.status === "complete" &&
      await stageHasEvidenceGap(project, runId, stage)) selected.push(stage);
  }
  if (!selected.length) throw new Error("Only failed or limited-evidence stages can be retried");
  if (!run.confirmedBrand) {
    if (!canRetryFailedBrandResolution(run.status, run.confirmedBrand, selected)) {
      throw new Error("A failed brand-resolution stage can only be retried by requesting brand_resolution");
    }
    const requeued = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${"research-active:" + project.id}))`);
      const [active] = await tx.select({ id: researchRunsTable.id }).from(researchRunsTable).where(and(
        eq(researchRunsTable.projectId, project.id),
        inArray(researchRunsTable.status, ["queued", "running"]),
      )).limit(1);
      if (active) throw new Error("A research run is already queued or running for this project");
      const [updated] = await tx.update(researchRunsTable).set({
        status: "queued",
        stage: "brand_resolution",
        stages: updateStage(run.stages as RunStage[], "brand_resolution", "pending"),
        lastAttemptedAt: new Date(),
        errorMessage: null,
        completedAt: null,
        coverageSnapshot: null,
        coverageSnapshotAt: null,
        coverageSnapshotStatus: "unavailable",
      }).where(and(
        eq(researchRunsTable.id, runId),
        eq(researchRunsTable.projectId, project.id),
        eq(researchRunsTable.status, "failed"),
      )).returning();
      return updated;
    });
    if (!requeued) throw new Error("Research run is already processing");
    void runBrandResolution(runId, project).catch((error: unknown) => {
      logger.error({ err: error, researchRunId: runId }, "Brand resolution retry failed");
      void markRunFailed(runId, error);
    });
    return await getRun(project.id, requeued.id);
  }
  if (selected.includes("brand_resolution")) {
    throw new Error("Brand resolution cannot be retried after a brand has been confirmed");
  }
  if (selected.includes("competitor_discovery") && selected.length !== 1) {
    throw new Error("Competitor discovery must be retried separately because it requires review");
  }
  await backfillCoverageBeforeRetry(project, run);
  // Retrying creates a provenance-linked run, but schedules only explicitly
  // selected failed/limited stages. Other stage results are retained as status.
  const retry = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${"research-active:" + project.id}))`);
    const [active] = await tx.select({ id: researchRunsTable.id }).from(researchRunsTable).where(and(
      eq(researchRunsTable.projectId, project.id),
      inArray(researchRunsTable.status, ["queued", "running"]),
    )).limit(1);
    if (active) throw new Error("A research run is already queued or running for this project");
    const [created] = await tx.insert(researchRunsTable).values({
      projectId: project.id,
      scope: `retry:${run.id}:${selected.join(",")}`,
      status: "queued",
      stage: selected[0]!,
      stages: stageKeys.map((key) => {
        const previous = previousStages.find((stage) => stage.key === key);
        if (selected.includes(key)) return { key, status: "pending" as const };
        return {
          key,
          status: (previous?.status ?? "pending") as StageState,
          note: `Retained from prior run ${run.id}${previous?.note ? `: ${previous.note}` : ""}`.slice(0, 500),
        };
      }),
      brand: run.brand,
      lastAttemptedAt: new Date(),
      market: run.market,
      focus: run.focus,
      confirmedBrand: run.confirmedBrand,
      brandCandidates: run.brandCandidates,
      competitorCandidates: run.competitorCandidates,
    }).returning();
    return created;
  });
  if (!retry) throw new Error("Could not create retry run");
  const selectedCompetitors = (run.competitorCandidates as CompetitorCandidate[]).filter((candidate) => candidate.selected).map((candidate) => candidate.name);
  void runRemainingStages(retry.id, project, run.confirmedBrand as Candidate, selectedCompetitors, selected).catch((error: unknown) => {
    logger.error({ err: error, researchRunId: retry.id }, "Research retry failed");
    void markRunFailed(retry.id, error);
  });
  return await getRun(project.id, retry.id);
}

export async function resolveResearchGaps(project: ProjectContext, runId: string, gapStageKeys: string[]) {
  const run = await loadRun(runId);
  if (run.projectId !== project.id) throw new Error("Research run not found");
  if (!canResolveResearchGaps(run.confirmedBrand)) {
    throw new Error("Brand must be confirmed before resolving research gaps");
  }
  const allowed = new Set(evidenceGapRetryStages);
  const requested = [...new Set(gapStageKeys.filter((key) => allowed.has(key)))];
  if (!requested.length) throw new Error("No retryable research evidence-gap stages were requested");
  return retryRunStages(project, runId, requested);
}

export async function getRun(projectId: string, runId: string) {
  const [run] = await db.select().from(researchRunsTable).where(and(
    eq(researchRunsTable.id, runId),
    eq(researchRunsTable.projectId, projectId),
  ));
  if (!run) return run;
  const [identity] = await db.select({
    enteredBrandName: pitchProjectsTable.enteredBrandName,
    canonicalBrandName: pitchProjectsTable.canonicalBrandName,
    officialWebsite: pitchProjectsTable.officialWebsite,
    regionalEntity: pitchProjectsTable.regionalEntity,
  }).from(pitchProjectsTable).where(eq(pitchProjectsTable.id, projectId));
  return { ...run, ...identity };
}

export async function listRuns(projectId: string) {
  const runs = await db.select().from(researchRunsTable).where(eq(researchRunsTable.projectId, projectId))
    .orderBy(desc(researchRunsTable.requestedAt));
  const [identity] = await db.select({
    enteredBrandName: pitchProjectsTable.enteredBrandName,
    canonicalBrandName: pitchProjectsTable.canonicalBrandName,
    officialWebsite: pitchProjectsTable.officialWebsite,
    regionalEntity: pitchProjectsTable.regionalEntity,
  }).from(pitchProjectsTable).where(eq(pitchProjectsTable.id, projectId));
  return runs.map((run) => ({ ...run, ...identity }));
}

async function resumeQueuedResearchRuns(): Promise<void> {
  const queuedRuns = await db.select().from(researchRunsTable).where(eq(researchRunsTable.status, "queued"));
  for (const run of queuedRuns) {
    if (run.scope !== "live_research_v1" && run.scope !== pitchFocusedScope && !run.scope.startsWith("retry:")) continue;
    const project = await loadProjectContext(run.projectId);
    if (!project) continue;
    if (!run.confirmedBrand) {
      void runBrandResolution(run.id, project).catch((error: unknown) => {
        logger.error({ err: error, researchRunId: run.id }, "Queued brand-resolution resume failed");
        void markRunFailed(run.id, error);
      });
      continue;
    }
    const stages = run.stages as RunStage[];
    if (run.scope.startsWith("retry:")) {
      const requested = selectedStagesFromRetryScope(run.scope);
      const selected = requested?.filter((key) => {
        const stage = stages.find((item) => item.key === key);
        return !!stage && (stage.status === "pending" || stage.status === "running") &&
          !stage.note?.startsWith("Retained from prior run ");
      }) ?? [];
      if (!selected.length) {
        await db.update(researchRunsTable).set({
          status: "failed",
          errorMessage: "Retry run has no safely resumable explicitly selected stages",
          completedAt: new Date(),
        }).where(and(eq(researchRunsTable.id, run.id), eq(researchRunsTable.status, "queued")));
        continue;
      }
      const competitors = (run.competitorCandidates as CompetitorCandidate[])
        .filter((candidate) => candidate.selected).map((candidate) => candidate.name);
      void runRemainingStages(run.id, project, run.confirmedBrand as Candidate, competitors, selected).catch((error: unknown) => {
        logger.error({ err: error, researchRunId: run.id }, "Queued targeted retry resume failed");
        void markRunFailed(run.id, error);
      });
      continue;
    }
    if (run.scope === pitchFocusedScope) {
      const selected = pitchFocusedStages.filter((key) => {
        const stage = stages.find((item) => item.key === key);
        return !!stage && (stage.status === "pending" || stage.status === "running");
      });
      if (!selected.length) {
        await db.update(researchRunsTable).set({
          status: "failed",
          errorMessage: "Interrupted pitch-focused run had no safely resumable pending stages",
          completedAt: new Date(),
        }).where(and(eq(researchRunsTable.id, run.id), eq(researchRunsTable.status, "queued")));
        continue;
      }
      void runRemainingStages(run.id, project, run.confirmedBrand as Candidate, [], selected).catch((error: unknown) => {
        logger.error({ err: error, researchRunId: run.id }, "Queued pitch-focused research resume failed");
        void markRunFailed(run.id, error);
      });
      continue;
    }
    if (run.stage === "company_research" || run.stage === "competitor_discovery") {
      void runCompanyAndDiscovery(run.id, project, run.confirmedBrand as Candidate).catch((error: unknown) => {
        logger.error({ err: error, researchRunId: run.id }, "Queued company-research resume failed");
        void markRunFailed(run.id, error);
      });
      continue;
    }
    const selected = stageKeys.filter((key) => {
      const stage = stages.find((item) => item.key === key);
      return !!stage && (stage.status === "pending" || stage.status === "running") &&
        !stage.note?.startsWith("Retained from prior run ");
    });
    if (!selected.length) {
      await db.update(researchRunsTable).set({
        status: "failed",
        errorMessage: "Interrupted run had no safely resumable pending stages",
        completedAt: new Date(),
      }).where(and(eq(researchRunsTable.id, run.id), eq(researchRunsTable.status, "queued")));
      continue;
    }
    const competitors = (run.competitorCandidates as CompetitorCandidate[]).filter((candidate) => candidate.selected).map((candidate) => candidate.name);
    void runRemainingStages(run.id, project, run.confirmedBrand as Candidate, competitors, selected).catch((error: unknown) => {
      logger.error({ err: error, researchRunId: run.id }, "Queued research-stage resume failed");
      void markRunFailed(run.id, error);
    });
  }
}

process.once("SIGTERM", () => {
  void queueActiveRunsForShutdown();
});
process.once("SIGINT", () => {
  void queueActiveRunsForShutdown();
});
void resumeQueuedResearchRuns().catch((error: unknown) => {
  logger.error({ err: error }, "Could not resume queued live-research runs");
});
