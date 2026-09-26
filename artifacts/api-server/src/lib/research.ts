import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import {
  campaignsTable,
  clientsTable,
  competitorsTable,
  db,
  pitchProjectsTable,
  researchClaimsTable,
  claimReviewsTable,
  researchRunsTable,
  sourcesTable,
  strategyDecisionsTable,
} from "@workspace/db";
import { lastAttemptTimestamp } from "./research-orchestrator-rules";

// A provider returns evidence, not finished presentation copy. A future live adapter
// can implement this interface without changing the project API or UI.
export interface ResearchSource {
  title: string;
  url: string;
  publisher: string;
  publishedAt: Date;
  retrievedAt: Date;
}
export interface EvidenceClaim {
  claim: string;
  category: string;
  claimType: "verified_fact" | "reported_claim" | "estimate" | "ai_interpretation";
  confidence: "confirmed" | "strongly_indicated" | "estimated" | "user_provided";
  source?: ResearchSource;
}
export interface ResearchProvider {
  researchCompany(input: ProjectContext): Promise<EvidenceClaim[]>;
  researchCompetitors(input: ProjectContext): Promise<EvidenceClaim[]>;
  researchCampaigns(input: ProjectContext): Promise<EvidenceClaim[]>;
}
export interface StrategyService {
  derive(input: { project: ProjectContext; claims: EvidenceClaim[] }): Promise<unknown>;
}
export interface ProjectContext {
  id: string;
  clientName: string;
  enteredBrandName: string;
  canonicalBrandName: string | null;
  officialWebsite: string | null;
  regionalEntity: string | null;
  market: string;
  category: string | null;
  productFocus: string | null;
  pitchObjective: string | null;
  isDemo: boolean;
}

// Deliberately unconfigured. A sample fixture is NOT a live research provider.
export const liveResearchProvider: ResearchProvider | null = null;

export function assertSourceForFactualClaim(claim: EvidenceClaim): void {
  if (claim.claimType === "ai_interpretation") return;
  if (!claim.source?.url || !claim.source.publisher || !claim.source.publishedAt || !claim.source.retrievedAt) {
    throw new Error("Factual claims require a dated, retrievable source with a publisher");
  }
}

const companyFields = [
  ["overview", "Company overview"],
  ["business_model", "Business model"],
  ["products", "Products / services"],
  ["key_markets", "Key markets"],
  ["target_audience", "Target audience"],
  ["positioning", "Positioning"],
  ["developments", "Relevant business developments"],
] as const;
const marketFields = [
  ["context", "Market context"],
  ["category_trends", "Category trends"],
  ["consumer_trends", "Consumer trends"],
  ["growth_drivers", "Growth drivers"],
  ["opportunities", "Relevant opportunities"],
  ["risks", "Risks / challenges"],
] as const;
const marketingFields = [
  ["overview", "Recent marketing overview"],
  ["promotion", "Latest identified promotions"],
  ["digital", "Digital"],
  ["social", "Social"],
  ["performance", "Performance marketing"],
  ["influencers", "Influencers"],
  ["sponsorship", "Sponsorship"],
  ["events", "Events"],
  ["ooh", "OOH"],
  ["dooh", "DOOH"],
  ["transit", "Transit advertising"],
  ["spend", "Marketing spend"],
] as const;

const strategyFields = [
  ["why_now", "Why Pitch This Brand Now?"],
  ["business_trigger", "Business Trigger"],
  ["marketing_trigger", "Marketing Trigger"],
  ["competitor_trigger", "Competitor Trigger"],
  ["ooh_gap", "OOH Gap"],
  ["audience", "Recommended Audience"],
  ["territory", "Recommended Communication Territory"],
  ["recommended_ooh", "Recommended OOH Direction"],
  ["hypothesis", "Pitch Hypothesis"],
  ["white_space", "White Space Opportunities"],
] as const;

function normalizeEvidenceText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function textNamesCampaign(text: string | null, campaignName: string): boolean {
  const normalizedName = normalizeEvidenceText(campaignName);
  return !!text && normalizedName.length >= 4 &&
    ` ${normalizeEvidenceText(text)} `.includes(` ${normalizedName} `);
}

function quoteSentenceForCampaign(quote: string | null, campaignName: string): string | null {
  if (!quote) return null;
  return quote.split(/(?<=[.!?])\s+/).find((sentence) => textNamesCampaign(sentence, campaignName)) ?? null;
}

function campaignQuoteProvesText(quote: string | null, campaignName: string, value: string | null): boolean {
  if (!value) return false;
  const sentence = quoteSentenceForCampaign(quote, campaignName);
  return !!sentence && textNamesCampaign(sentence, value);
}

function campaignQuoteProvesDates(quote: string | null, campaignName: string, startDate: string | null, endDate: string | null): boolean {
  if (!startDate || !endDate) return false;
  const sentence = quoteSentenceForCampaign(quote, campaignName);
  if (!sentence) return false;
  const normalizedSentence = normalizeEvidenceText(sentence);
  return normalizedSentence.includes(normalizeEvidenceText(startDate)) &&
    normalizedSentence.includes(normalizeEvidenceText(endDate));
}

function classifyOohMediumQuote(quote: string | null, campaignName: string): string | null {
  const sentence = quoteSentenceForCampaign(quote, campaignName);
  if (!sentence) return null;
  const normalizedSentence = normalizeEvidenceText(sentence);
  const nameIndex = normalizedSentence.indexOf(normalizeEvidenceText(campaignName));
  const placements: Array<[string, RegExp]> = [
    ["Bus Shelter", /\bbus shelters?\b/i],
    ["Bus", /\b(?:bus wraps?|vehicle wraps?)\b/i],
    ["Billboard", /\b(?:digital )?billboards?\b|\bhoardings?\b/i],
    ["Digital Screens", /\b(?:bridge|roadside) screens?\b/i],
    ["Metro", /\bmetro (?:station )?advertising\b/i],
    ["Taxi", /\btaxi (?:advertising|wraps?)\b/i],
    ["Airport", /\bairport (?:advertising|screens?)\b/i],
    ["Mall", /\b(?:shopping )?mall screens?\b|\bmall advertising\b/i],
    ["Street Furniture", /\b(?:street furniture|mupis?|kiosks?|lamp posts?)\b/i],
  ];
  for (const [medium, pattern] of placements) {
    const match = pattern.exec(sentence);
    if (!match) continue;
    const mediumIndex = normalizeEvidenceText(sentence.slice(0, match.index)).length;
    const normalizedMediumLength = normalizeEvidenceText(match[0]).length;
    const before = normalizedSentence.slice(Math.max(0, mediumIndex - 40), mediumIndex);
    const after = normalizedSentence.slice(mediumIndex + normalizedMediumLength, mediumIndex + normalizedMediumLength + 40);
    const relationBefore = /\b(?:on|across|at|via|through|using|featured|advertised|displayed|placed|ran|mounted|installed|wrapped|used|included)\s+(?:[a-z]+\s+){0,2}$/.test(before);
    const relationAfter = /^(?:\s+[a-z]+){0,2}\s+(?:for|promoting|featuring|carrying|showing)\b/.test(after);
    if (Math.abs(nameIndex - mediumIndex) <= 120 && (relationBefore || relationAfter)) return medium;
  }
  return null;
}

function hasSourcePublicationDate(source: {
  url: string | null;
  publisher: string | null;
  publishedAt: Date | null;
  retrievedAt: Date | null;
} | null, asOf = new Date()): boolean {
  return !!source?.url && !!source.publisher && !!source.publishedAt && !!source.retrievedAt &&
    source.publishedAt <= asOf;
}

function sampleRunId(projectId: string): string {
  // Preserve already-seeded demo fixture IDs. User-created project UUIDs are
  // unique and can safely serve as the fixture-run ID in a different table.
  return projectId.startsWith("33333333-") ? `55555555${projectId.slice(8)}` : projectId;
}

async function ensureSampleFixture(project: ProjectContext): Promise<void> {
  await db.transaction(async (tx) => {
    const [run] = await tx.insert(researchRunsTable).values({
      id: sampleRunId(project.id),
      projectId: project.id,
      scope: "sample_fixture_v1",
      status: "completed",
    }).onConflictDoNothing().returning();
    if (!run) return;

    const [audience, market] = await tx.insert(researchClaimsTable).values([
      {
        projectId: project.id,
        researchRunId: run.id,
        claim: `Illustrative hypothesis: a neighborhood-level audience might be relevant to a ${project.category ?? "brand"} OOH pitch. This is not observed brand activity.`,
        category: "company.target_audience",
        claimType: "ai_interpretation",
        confidence: "estimated",
        geography: project.market,
        isDemo: true,
      },
      {
        projectId: project.id,
        researchRunId: run.id,
        claim: `Illustrative planning angle: investigate the role of local routines in ${project.market}. This is not verified market research.`,
        category: "market.context",
        claimType: "ai_interpretation",
        confidence: "estimated",
        geography: project.market,
        isDemo: true,
      },
    ]).returning();

    await tx.insert(competitorsTable).values([
      {
        projectId: project.id,
        name: "Illustrative competitor A",
        category: project.category,
        positioning: "Example positioning to validate",
        mainProducts: "Not researched",
        recentMarketing: "Not researched",
        outdoorActivity: "Not researched",
        mainMessage: "Example convenience territory — not an observed message",
        strengths: "Sample comparison prompt only",
        observableGaps: "No observed gaps verified",
        currentPromotion: "Not researched",
        doohActivity: "Not researched",
        transitActivity: "Not researched",
        evidenceClaimIds: [],
        isDemo: true,
      },
      {
        projectId: project.id,
        name: "Illustrative competitor B",
        category: project.category,
        positioning: "Alternative example positioning to validate",
        mainProducts: "Not researched",
        recentMarketing: "Not researched",
        outdoorActivity: "Not researched",
        mainMessage: "Example value territory — not an observed message",
        strengths: "Sample comparison prompt only",
        observableGaps: "No observed gaps verified",
        currentPromotion: "Not researched",
        doohActivity: "Not researched",
        transitActivity: "Not researched",
        evidenceClaimIds: [],
        isDemo: true,
      },
    ]);
    await tx.insert(campaignsTable).values([
      {
        projectId: project.id,
        name: "Illustrative transit concept",
        brandOrProduct: project.clientName,
        productFocus: project.productFocus,
        geography: project.market,
        medium: "OOH",
        oohMediumType: "Bus Shelter",
        message: "Concept only — not an identified campaign",
        confidence: "estimated",
        isDemo: true,
      },
      {
        projectId: project.id,
        name: "Illustrative digital concept",
        brandOrProduct: project.clientName,
        productFocus: project.productFocus,
        geography: project.market,
        medium: "DOOH",
        oohMediumType: "Digital OOH",
        message: "Concept only — not an identified campaign",
        confidence: "estimated",
        isDemo: true,
      },
    ]);
    await tx.insert(strategyDecisionsTable).values(strategyFields.map(([key]) => ({
      projectId: project.id,
      decisionType: key,
      recommendation: { text: `Illustrative ${key.replaceAll("_", " ")} direction for ${project.clientName}; validate before use.` },
      rationale: "Sample interpretation only. No verified competitive or campaign evidence has been collected.",
      evidenceClaimIds: [audience.id, market.id],
      isDemo: true,
    })));
  });
}

export async function loadProjectContext(id: string): Promise<ProjectContext | undefined> {
  const [row] = await db.select({
    id: pitchProjectsTable.id,
    clientName: sql<string>`coalesce(${pitchProjectsTable.canonicalBrandName}, ${clientsTable.name})`,
    enteredBrandName: sql<string>`coalesce(${pitchProjectsTable.enteredBrandName}, ${clientsTable.name})`,
    canonicalBrandName: pitchProjectsTable.canonicalBrandName,
    officialWebsite: pitchProjectsTable.officialWebsite,
    regionalEntity: pitchProjectsTable.regionalEntity,
    market: pitchProjectsTable.market,
    category: pitchProjectsTable.category,
    productFocus: pitchProjectsTable.productFocus,
    pitchObjective: pitchProjectsTable.pitchObjective,
    isDemo: pitchProjectsTable.isDemo,
  }).from(pitchProjectsTable)
    .innerJoin(clientsTable, eq(pitchProjectsTable.clientId, clientsTable.id))
    .where(eq(pitchProjectsTable.id, id));
  return row;
}

export async function getProjectIntelligence(
  project: ProjectContext,
  qualityAsOf: Date = new Date(),
  qualityRunId?: string,
) {
  if (project.isDemo) await ensureSampleFixture(project);
  const projectClaims = eq(researchClaimsTable.projectId, project.id);
  const projectCompetitors = eq(competitorsTable.projectId, project.id);
  const projectCampaigns = eq(campaignsTable.projectId, project.id);
  const projectDecisions = eq(strategyDecisionsTable.projectId, project.id);
  const [claims, competitors, campaigns, decisions, runs, reviews] = await Promise.all([
    db.select().from(researchClaimsTable).where(project.isDemo ? projectClaims : and(projectClaims, eq(researchClaimsTable.isDemo, false))),
    db.select().from(competitorsTable).where(project.isDemo ? projectCompetitors : and(projectCompetitors, eq(competitorsTable.isDemo, false))),
    db.select().from(campaignsTable).where(project.isDemo ? projectCampaigns : and(projectCampaigns, eq(campaignsTable.isDemo, false))).orderBy(desc(campaignsTable.startDate)),
    db.select().from(strategyDecisionsTable).where(project.isDemo ? projectDecisions : and(projectDecisions, eq(strategyDecisionsTable.isDemo, false))),
    db.select().from(researchRunsTable).where(and(
      eq(researchRunsTable.projectId, project.id),
    )).orderBy(desc(researchRunsTable.requestedAt)),
    db.select().from(claimReviewsTable).where(eq(claimReviewsTable.projectId, project.id))
      .orderBy(desc(claimReviewsTable.reviewedAt)),
  ]);
  const sourceIds = [
    ...claims.flatMap((claim) => claim.sourceId ? [claim.sourceId] : []),
    ...campaigns.flatMap((campaign) => campaign.sourceId ? [campaign.sourceId] : []),
    ...campaigns.flatMap((campaign) => campaign.sourceIds),
    ...reviews.flatMap((review) => review.verifiedSourceId ? [review.verifiedSourceId] : []),
  ];
  const sources = sourceIds.length
    ? await db.select().from(sourcesTable).where(inArray(sourcesTable.id, sourceIds))
    : [];
  const bySource = new Map(sources.filter((source) => source.createdAt <= qualityAsOf)
    .map((source) => [source.id, source]));
  const sourceFor = (id: string | null) => {
    const source = id ? bySource.get(id) : null;
    if (!source) return null;
    return {
      id: source.id,
      title: source.title,
      url: source.url,
      publisher: source.publisher,
      publishedAt: source.publishedAt,
      retrievedAt: source.retrievedAt,
      qualityScore: source.qualityScore,
      sourceKind: source.sourceKind,
      snippet: source.snippet,
    };
  };
  const latestReviewByClaim = new Map<string, typeof reviews[number]>();
  for (const review of reviews.filter((item) => item.reviewedAt <= qualityAsOf)) {
    if (!latestReviewByClaim.has(review.claimId)) latestReviewByClaim.set(review.claimId, review);
  }
  const isSupportedFact = (claim: typeof claims[number]) => {
    const review = latestReviewByClaim.get(claim.id);
    const source = sourceFor(claim.sourceId);
    const effectiveStatus = review?.decision ?? claim.status;
    return effectiveStatus === "approved" && !!source?.url && !!source.publisher &&
      !!source.publishedAt && source.publishedAt <= qualityAsOf && !!source.retrievedAt &&
      (!review || (!!review.sourceQuote && !!review.quoteVerifiedAt));
  };
  const exposedClaims = claims.filter((claim) =>
    (latestReviewByClaim.get(claim.id)?.decision ?? claim.status) !== "rejected" &&
    (latestReviewByClaim.get(claim.id)?.decision ?? claim.status) !== "superseded" &&
    (claim.isDemo || claim.claimType === "ai_interpretation" ||
      claim.status === "draft" || latestReviewByClaim.get(claim.id)?.decision === "needs_review" ||
      isSupportedFact(claim)));
  const hasLiveEvidence = exposedClaims.some((claim) => !claim.isDemo && isSupportedFact(claim));
  const visibleClaims = hasLiveEvidence ? exposedClaims.filter((claim) => !claim.isDemo) : exposedClaims;
  const supportedClaimIds = new Set(visibleClaims.filter(isSupportedFact).map((claim) => claim.id));
  const entries = (group: string, fields: readonly (readonly [string, string])[]) =>
    fields.map(([key, label]) => {
      const matching = visibleClaims.filter((claim) =>
        claim.category === `${group}.${key}` && (isSupportedFact(claim) || claim.isDemo))
        .sort((a, b) => Number(isSupportedFact(b)) - Number(isSupportedFact(a)));
      const special = group === "marketing" && key === "spend" ? "No reliable public marketing-spend figure identified." : null;
      const marketValue = group === "company" && key === "key_markets"
        ? `Project market: ${project.market} (workspace input, not verified operating markets)` : null;
      const focusValue = group === "company" && key === "products" && project.productFocus
        ? `Project focus: ${project.productFocus} (workspace input, not verified product data)` : null;
      return {
        key,
        label,
        value: matching[0]?.claim ?? special ?? marketValue ?? focusValue,
        claimIds: matching.map((claim) => claim.id),
        isDemo: matching.some((claim) => claim.isDemo) || (project.isDemo && !!(marketValue || focusValue)),
      };
    });

  const actualRuns = runs.filter((run) => run.scope !== "sample_fixture_v1");
  const latest = actualRuns[0];
  const evidenceRunIds = actualRuns.filter((run) => run.requestedAt <= qualityAsOf).map((run) => run.id);
  const evidenceRunSet = new Set(evidenceRunIds);
  const projectionRunId = qualityRunId ?? latest?.id ?? null;
  const lastCompleted = actualRuns.find((run) =>
    (run.status === "completed" || run.status === "partial_success") && run.completedAt);
  const selectedCompetitors = latest?.competitorCandidates.filter((candidate) => candidate.selected) ?? [];
  const selectedCompetitorNames = new Set(selectedCompetitors.map((candidate) => candidate.name.toLowerCase()));
  const visibleCompetitors = competitors.filter((row) =>
    (!hasLiveEvidence && row.isDemo) ||
    (!row.isDemo && (row.evidenceClaimIds.some((id) => supportedClaimIds.has(id)) ||
      selectedCompetitorNames.has(row.name.toLowerCase()))));
  const unresearchedCompetitors = selectedCompetitors
    .filter((candidate) => !visibleCompetitors.some((row) => row.name.toLowerCase() === candidate.name.toLowerCase()))
    .map((candidate) => {
      const hash = createHash("sha256").update(`${project.id}:${candidate.name.toLowerCase()}`).digest("hex");
      return {
        id: `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`,
        name: candidate.name,
        positioning: null,
        mainProducts: null,
        recentMarketing: null,
        outdoorActivity: null,
        mainMessage: null,
        strengths: null,
        observableGaps: null,
        currentPromotion: null,
        doohActivity: null,
        transitActivity: null,
        evidenceClaimIds: [] as string[],
        isDemo: false,
        verificationStatus: "Insufficient Evidence" as const,
        verificationEvidence: {
          officialIdentity: false,
          uaePresence: false,
          category: false,
          positioning: false,
          recentActivity: false,
        },
      };
    });
  const liveClaims = exposedClaims.filter((claim) => !claim.isDemo);
  const state = !latest ? "research_not_started"
    : latest.status === "queued" || latest.status === "running" ? "researching"
      : latest.status === "awaiting_brand_confirmation" ? "awaiting_brand_confirmation"
        : latest.status === "awaiting_competitor_review" ? "awaiting_competitor_review"
          : latest.status === "partial_success" ? "partial_success"
      : latest.status === "failed" ? "needs_review"
        : !liveClaims.some((claim) =>
          claim.researchRunId === latest.id && isSupportedFact(claim)) ||
          liveClaims.some((claim) => claim.researchRunId === latest.id && claim.status === "draft")
          ? "needs_review"
          : latest.completedAt && Date.now() - latest.completedAt.getTime() > 30 * 86400000
            ? "update_available" : "research_complete";
  const competitorVerification = new Map(visibleCompetitors.map((row) => {
    const competitorClaims = visibleClaims.filter((claim) =>
      row.evidenceClaimIds.includes(claim.id) && isSupportedFact(claim) &&
      evidenceRunSet.has(claim.researchRunId ?? "") && claim.createdAt <= qualityAsOf);
    const evidence = {
      officialIdentity: competitorClaims.some((claim) => /official_identity|identity|official_profile/.test(claim.category.toLowerCase())),
      uaePresence: competitorClaims.some((claim) => /uae_presence|united_arab_emirates/.test(claim.category.toLowerCase())),
      category: competitorClaims.some((claim) => /competitor\.category|category/.test(claim.category.toLowerCase())),
      positioning: competitorClaims.some((claim) => /positioning/.test(claim.category.toLowerCase())),
      recentActivity: competitorClaims.some((claim) => {
        if (!/recent_activity|recent_marketing|campaign|promotion/.test(claim.category.toLowerCase())) return false;
        const source = sourceFor(claim.sourceId);
        return !!source?.publishedAt && source.publishedAt.getTime() >= qualityAsOf.getTime() - 365 * 86400000;
      }),
    };
    return [row.id, {
      evidence,
      status: Object.values(evidence).every(Boolean) ? "Verified"
        : Object.values(evidence).some(Boolean) ? "Partially Verified" : "Insufficient Evidence",
    }] as const;
  }));
  const campaignRows = campaigns.filter((row) =>
    ((!hasLiveEvidence || !row.isDemo) && row.createdAt <= qualityAsOf && row.updatedAt <= qualityAsOf)).map((row) => {
    const sourceList = [...new Set([row.sourceId, ...row.sourceIds].filter((id): id is string => !!id))]
      .map(sourceFor).filter((source): source is NonNullable<typeof source> => !!source);
    const quoteSource = sourceFor(row.sourceId);
    const evidenceQuote = row.evidenceQuote?.trim() || null;
    const validatedOohEvidence = (row.evidenceStatus === "confirmed_ooh" || row.evidenceStatus === "likely_ooh") &&
      !!evidenceQuote && !!quoteSource && (quoteSource.qualityScore ?? 0) >= 70 &&
      hasSourcePublicationDate(quoteSource, qualityAsOf) &&
      !!classifyOohMediumQuote(evidenceQuote, row.name);
    const quote = validatedOohEvidence ? evidenceQuote : null;
    const sourcePublishedAt = quoteSource && hasSourcePublicationDate(quoteSource, qualityAsOf)
      ? quoteSource.publishedAt : null;
    const campaignIdentityValid = textNamesCampaign(quoteSource?.title ?? null, row.name) ||
      !!quoteSentenceForCampaign(evidenceQuote, row.name);
    const dateRangeQuoteValid = campaignQuoteProvesDates(evidenceQuote, row.name, row.startDate, row.endDate);
    const campaignDatesSupported = dateRangeQuoteValid;
    const campaignLocationSupported = campaignQuoteProvesText(evidenceQuote, row.name, row.location);
    const campaignGeographySupported = campaignQuoteProvesText(evidenceQuote, row.name, row.geography);
    const campaignMessageSupported = campaignQuoteProvesText(evidenceQuote, row.name, row.message);
    const sourceBacked = !row.isDemo && !!sourcePublishedAt &&
      (quoteSource?.qualityScore ?? 0) >= 70 && campaignIdentityValid;
    const sourceRecent = !!sourcePublishedAt && sourcePublishedAt.getTime() >= qualityAsOf.getTime() - 365 * 86400000;
    const sourceFresh = !!sourcePublishedAt && sourcePublishedAt.getTime() >= qualityAsOf.getTime() - 90 * 86400000;
    const today = qualityAsOf.toISOString().slice(0, 10);
    const active = sourceBacked && campaignDatesSupported && sourceFresh && !!row.startDate && !!row.endDate &&
      row.startDate <= today && row.endDate >= today;
    const recent = sourceBacked && campaignDatesSupported && sourceRecent && !!row.endDate && row.endDate < today &&
      new Date(`${row.endDate}T00:00:00Z`).getTime() >= qualityAsOf.getTime() - 90 * 86400000;
    return {
      row,
      sourceList,
      quote,
      sourcePublishedAt,
      sourceBacked,
      campaignDatesSupported: sourceBacked && campaignDatesSupported,
      campaignLocationSupported: sourceBacked && campaignLocationSupported,
      campaignGeographySupported: sourceBacked && campaignGeographySupported,
      campaignMessageSupported: sourceBacked && campaignMessageSupported,
      mediumType: validatedOohEvidence && quote ? classifyOohMediumQuote(quote, row.name) : null,
      active,
      recent,
      identifiable: sourceBacked && !!row.name.trim() && !!sourcePublishedAt,
    };
  });
  const latestIdentifiableCampaign = campaignRows.filter((campaign) => campaign.identifiable)
    .sort((a, b) => (b.sourcePublishedAt?.getTime() ?? 0) - (a.sourcePublishedAt?.getTime() ?? 0))[0];
  const promotionSummary = campaignRows.some((campaign) => campaign.active)
    ? "Confirmed Active" as const : "No Verified Active Promotion" as const;
  const latestPromotionStage = (latest?.stages as Array<{ key: string; status: string }> | undefined)
    ?.find((stage) => stage.key === "current_promotion");
  const projectedPromotionSummary = latestPromotionStage &&
    ["complete", "limited_evidence", "failed"].includes(latestPromotionStage.status)
    ? promotionSummary : "Not researched" as const;
  const specificOohMediumAvailable = campaignRows.some((campaign) =>
    evidenceRunSet.has(campaign.row.researchRunId ?? "") &&
    campaign.row.createdAt <= qualityAsOf && campaign.row.updatedAt <= qualityAsOf &&
    !!campaign.mediumType && !!campaign.quote);
  const verifiedCompetitorIds = new Set([...competitorVerification.entries()]
    .filter(([, item]) => item.status === "Verified").map(([id]) => id));
  const strategyEvidenceStrength = (row: typeof decisions[number]): "Strong" | "Limited" => {
    const decisionClaims = visibleClaims.filter((claim) =>
      row.evidenceClaimIds.includes(claim.id) && isSupportedFact(claim) &&
      evidenceRunSet.has(claim.researchRunId ?? "") && claim.createdAt <= qualityAsOf);
    const categoryTerms: Record<string, string[]> = {
      why_now: ["company.", "marketing.", "campaign"],
      business_trigger: ["company.developments", "business_trigger"],
      marketing_trigger: ["marketing.", "promotion", "campaign"],
      competitor_trigger: ["competitor."],
      ooh_gap: ["ooh", "campaign", "marketing."],
      recommended_ooh: ["ooh", "campaign", "marketing."],
      audience: ["company.target_audience", "audience"],
      territory: ["positioning", "marketing."],
      hypothesis: ["company.", "competitor.", "marketing."],
      white_space: ["opportunit", "gap", "ooh", "competitor."],
    };
    const terms = categoryTerms[row.decisionType] ?? [];
    const relevantClaims = decisionClaims.filter((claim) =>
      terms.some((term) => claim.category.toLowerCase().includes(term)));
    const independentPublishers = new Set(relevantClaims.flatMap((claim) => {
      const url = sourceFor(claim.sourceId)?.url;
      if (!url) return [];
      try {
        return [new URL(url).hostname.toLowerCase().replace(/^www\./, "")];
      } catch {
        return [];
      }
    }));
    const oohDependent = row.decisionType === "ooh_gap" || row.decisionType === "recommended_ooh";
    const competitorDependent = row.decisionType === "competitor_trigger";
    const hasVerifiedLinkedCompetitor = competitorDependent && visibleCompetitors.some((competitor) =>
      verifiedCompetitorIds.has(competitor.id) &&
      (decisionClaims.some((claim) => claim.relatedCompetitorId === competitor.id) ||
        competitor.evidenceClaimIds.some((id) => decisionClaims.some((claim) => claim.id === id))));
    return relevantClaims.length > 0 && independentPublishers.size >= 2 &&
      (!oohDependent || specificOohMediumAvailable) &&
      (!competitorDependent || hasVerifiedLinkedCompetitor)
      ? "Strong" : "Limited";
  };

  return {
    projectId: project.id,
    isDemo: project.isDemo,
    sampleNotice: project.isDemo && !hasLiveEvidence && claims.some((claim) => claim.isDemo)
      ? "Illustrative sample records only. No live research has been performed; do not cite these as facts." : null,
    status: {
      state,
      lastResearched: lastCompleted?.completedAt ?? null,
      lastAttemptedAt: lastAttemptTimestamp(latest?.lastAttemptedAt, latest?.requestedAt),
      liveResearchAvailable: !!process.env.AI_INTEGRATIONS_OPENAI_BASE_URL && !!process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
      currentRunId: latest?.id ?? null,
      currentStage: latest?.stage ?? null,
    },
    identity: {
      enteredBrandName: project.enteredBrandName,
      canonicalBrandName: project.canonicalBrandName,
      officialWebsite: project.officialWebsite,
      regionalEntity: project.regionalEntity,
    },
    company: entries("company", companyFields),
    market: entries("market", marketFields),
    marketing: entries("marketing", marketingFields),
    claims: visibleClaims.map((claim) => ({
      id: claim.id,
      claim: claim.claim,
      category: claim.category,
      researchRunId: claim.researchRunId,
      relatedBrand: claim.relatedBrand,
      relatedCampaignId: claim.relatedCampaignId,
      relatedCompetitorId: claim.relatedCompetitorId,
      methodology: claim.methodology,
      claimType: claim.claimType,
      confidence: claim.confidence,
      status: latestReviewByClaim.get(claim.id)?.decision ?? claim.status,
      isDemo: claim.isDemo,
      source: sourceFor(claim.sourceId),
    })),
    competitors: [...visibleCompetitors.map((row) => {
       const supported = row.evidenceClaimIds.some((id) => supportedClaimIds.has(id));
       const verification = competitorVerification.get(row.id)!;
      return {
      id: row.id,
      name: row.name,
      positioning: supported ? row.positioning : null,
      mainProducts: supported ? row.mainProducts : null,
      recentMarketing: supported ? row.recentMarketing : null,
      outdoorActivity: supported ? row.outdoorActivity : null,
      mainMessage: supported ? row.mainMessage : null,
      strengths: supported ? row.strengths : null,
      observableGaps: supported ? row.observableGaps : null,
      currentPromotion: supported ? row.currentPromotion : null,
      doohActivity: supported ? row.doohActivity : null,
      transitActivity: supported ? row.transitActivity : null,
      evidenceClaimIds: row.evidenceClaimIds.filter((id) => supportedClaimIds.has(id)),
      isDemo: row.isDemo,
        verificationStatus: verification.status,
        verificationEvidence: verification.evidence,
      };
    }), ...unresearchedCompetitors],
    campaigns: campaignRows.map(({
      row, sourceList, quote, mediumType, active, recent, identifiable,
      campaignDatesSupported, campaignLocationSupported, campaignGeographySupported, campaignMessageSupported,
    }) => {
      const isLatestIdentifiable = !!latestIdentifiableCampaign && row.id === latestIdentifiableCampaign.row.id;
      const promotionClassification = active ? "Confirmed Active"
        : recent ? "Recently Active"
          : isLatestIdentifiable && identifiable ? "Latest Identifiable Campaign"
            : "No Verified Active Promotion";
      return ({
      id: row.id,
      name: row.name,
      brandOrProduct: row.brandOrProduct,
      productFocus: row.productFocus,
      startDate: campaignDatesSupported ? row.startDate : null,
      endDate: campaignDatesSupported ? row.endDate : null,
      geography: campaignGeographySupported ? row.geography : null,
      message: campaignMessageSupported ? row.message : null,
      medium: mediumType ? row.medium : null,
      oohMediumType: mediumType,
      oohMediumClassification: mediumType ?? "OOH — medium unverified",
      oohMediumSourceQuote: mediumType ? quote : null,
      location: campaignLocationSupported ? row.location : null,
      referenceImageUrl: row.referenceImageUrl,
      source: sourceFor(row.sourceId),
      sources: sourceList,
      confidence: row.confidence,
      isDemo: row.isDemo,
      evidenceStatus: mediumType &&
        (row.evidenceStatus === "confirmed_ooh" || row.evidenceStatus === "likely_ooh")
        ? row.evidenceStatus : "insufficient_evidence",
      promotionClassification,
      isCurrent: active,
    }); }),
    strategy: decisions.filter((row) =>
      (!hasLiveEvidence && row.isDemo) || (!row.isDemo && row.status !== "rejected" &&
        (row.evidenceClaimIds.length > 0 && row.evidenceClaimIds.every((id) => supportedClaimIds.has(id)) ||
          row.evidenceClaimIds.length === 0 &&
          row.recommendation.text === "Insufficient evidence to recommend a direction yet.")))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .filter((row, index, all) => all.findIndex((item) => item.decisionType === row.decisionType) === index)
      .sort((a, b) =>
        strategyFields.findIndex(([key]) => key === a.decisionType) -
        strategyFields.findIndex(([key]) => key === b.decisionType))
      .map((row) => ({
      id: row.id,
      key: row.decisionType,
      label: strategyFields.find(([key]) => key === row.decisionType)?.[1] ?? row.decisionType,
      recommendation: typeof row.recommendation.text === "string" ? row.recommendation.text : "",
      rationale: row.rationale,
      evidenceClaimIds: row.evidenceClaimIds,
      status: row.status,
      isDemo: row.isDemo,
      researchRunId: row.researchRunId,
        evidenceStrength: strategyEvidenceStrength(row),
    })),
    quality: buildQualityProjection({
      projectId: project.id,
      runId: projectionRunId,
      evidenceRunIds,
      asOf: qualityAsOf,
      promotionSummary: projectedPromotionSummary,
      claims: visibleClaims,
      supportedClaimIds,
      competitorEvidence: visibleCompetitors.map((row) => ({
        id: row.id,
        isDemo: row.isDemo,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        ...competitorVerification.get(row.id)!.evidence,
      })),
      campaigns: campaignRows.map(({ row, sourceBacked, mediumType, active, quote }) => ({
          ...row,
          sourceBacked,
          startDate: row.startDate && campaignQuoteProvesDates(row.evidenceQuote, row.name, row.startDate, row.endDate)
            ? row.startDate : null,
          endDate: row.endDate && campaignQuoteProvesDates(row.evidenceQuote, row.name, row.startDate, row.endDate)
            ? row.endDate : null,
          location: campaignQuoteProvesText(row.evidenceQuote, row.name, row.location) ? row.location : null,
          specificOohQuote: sourceBacked && !!mediumType && !!quote,
          activePromotion: active,
        })),
      decisions,
      strategyFields,
    }),
  };
}

function buildQualityProjection(input: {
  projectId: string;
  runId: string | null;
  evidenceRunIds: string[];
  asOf: Date;
  promotionSummary: "Confirmed Active" | "No Verified Active Promotion" | "Not researched";
  claims: Array<{ id: string; category: string; researchRunId: string | null; relatedCompetitorId: string | null; isDemo: boolean; createdAt: Date }>;
  supportedClaimIds: Set<string>;
  competitorEvidence: Array<{ id: string; isDemo: boolean; createdAt: Date; updatedAt: Date; officialIdentity: boolean; uaePresence: boolean; category: boolean; positioning: boolean; recentActivity: boolean }>;
  campaigns: Array<{ id: string; name: string; researchRunId: string | null; isDemo: boolean; sourceId: string | null; startDate: string | null; endDate: string | null; location: string | null; createdAt: Date; updatedAt: Date; sourceBacked: boolean; specificOohQuote: boolean; activePromotion: boolean }>;
  decisions: Array<{ decisionType: string; evidenceClaimIds: string[]; isDemo: boolean; researchRunId: string | null; createdAt: Date; updatedAt: Date }>;
  strategyFields: readonly (readonly [string, string])[];
}) {
  const criteria = {
    company: ["overview", "business_model", "products", "key_markets", "target_audience", "positioning", "developments"],
    competitors: ["official_identity", "uae_presence", "category", "positioning", "recent_activity"],
    currentPromotion: ["current_promotion_with_dated_source"],
    ooh: ["source_quote_identifies_specific_ooh_medium"],
    campaign: ["campaign_identity", "campaign_dates", "campaign_location", "campaign_source"],
    strategy: input.strategyFields.map(([key]) => key),
  } as const;
  const evidenceRuns = new Set(input.evidenceRunIds);
  const runClaims = input.claims.filter((claim) => evidenceRuns.has(claim.researchRunId ?? "") &&
    claim.createdAt <= input.asOf &&
    !claim.isDemo && input.supportedClaimIds.has(claim.id));
  const runClaimIds = new Set(runClaims.map((claim) => claim.id));
  const runDecisions = input.decisions.filter((row) => evidenceRuns.has(row.researchRunId ?? "") &&
    row.createdAt <= input.asOf && row.updatedAt <= input.asOf && !row.isDemo);
  const runCampaigns = input.campaigns.filter((row) => evidenceRuns.has(row.researchRunId ?? "") &&
    row.createdAt <= input.asOf && row.updatedAt <= input.asOf && !row.isDemo);
  const categoryHas = (...terms: string[]) => runClaims.some((claim) =>
    terms.some((term) => claim.category.toLowerCase().includes(term)));
  const matches = {
    company: {
      overview: categoryHas("company.overview"),
      business_model: categoryHas("company.business_model"),
      products: categoryHas("company.products"),
      key_markets: categoryHas("company.key_markets"),
      target_audience: categoryHas("company.target_audience"),
      positioning: categoryHas("company.positioning"),
      developments: categoryHas("company.developments"),
    },
    competitors: {
      official_identity: input.competitorEvidence.some((row) => !row.isDemo && row.createdAt <= input.asOf && row.updatedAt <= input.asOf && row.officialIdentity),
      uae_presence: input.competitorEvidence.some((row) => !row.isDemo && row.createdAt <= input.asOf && row.updatedAt <= input.asOf && row.uaePresence),
      category: input.competitorEvidence.some((row) => !row.isDemo && row.createdAt <= input.asOf && row.updatedAt <= input.asOf && row.category),
      positioning: input.competitorEvidence.some((row) => !row.isDemo && row.createdAt <= input.asOf && row.updatedAt <= input.asOf && row.positioning),
      recent_activity: input.competitorEvidence.some((row) => !row.isDemo && row.createdAt <= input.asOf && row.updatedAt <= input.asOf && row.recentActivity),
    },
    currentPromotion: { current_promotion_with_dated_source: runCampaigns.some((row) => row.activePromotion) },
    ooh: { source_quote_identifies_specific_ooh_medium: runCampaigns.some((row) => row.sourceBacked && row.specificOohQuote) },
    campaign: {
      campaign_identity: runCampaigns.some((row) => row.sourceBacked && !!row.name.trim()),
      campaign_dates: runCampaigns.some((row) => row.sourceBacked && !!row.startDate && !!row.endDate),
      campaign_location: runCampaigns.some((row) => row.sourceBacked && !!row.location?.trim()),
      campaign_source: runCampaigns.some((row) => row.sourceBacked),
    },
    strategy: Object.fromEntries(input.strategyFields.map(([key]) => [
      key,
      runDecisions.some((row) => row.decisionType === key && row.evidenceClaimIds.length > 0 &&
        row.evidenceClaimIds.every((id) => runClaimIds.has(id))),
    ])),
  } as Record<string, Record<string, boolean>>;
  const stageBySection: Record<string, string> = {
    company: "company_research",
    competitors: "competitor_research",
    currentPromotion: "current_promotion",
    ooh: "ooh_research",
    campaign: "campaign_research",
    strategy: "strategy_generation",
  };
  return {
    promotionSummary: input.promotionSummary,
    researchRunId: input.runId,
    asOf: input.asOf,
    evidenceRunIds: input.evidenceRunIds,
    ...Object.fromEntries(Object.entries(criteria).map(([section, required]) => {
    const coveredCriteria = required.filter((criterion) => matches[section]?.[criterion]);
    const missingCriteria = required.filter((criterion) => !matches[section]?.[criterion]);
    return [section, {
      percentage: Math.round(coveredCriteria.length / required.length * 100),
      coveredCriteria,
      requiredCriteria: [...required],
      missingCriteria,
      gaps: missingCriteria.map((criterion) => `Missing source-supported evidence for ${criterion.replaceAll("_", " ")}`),
      retryStages: missingCriteria.length ? [stageBySection[section]!] : [],
      researchRunId: input.runId,
      asOf: input.asOf,
      evidenceRunIds: input.evidenceRunIds,
    }];
  })),
  };
}