import { Router, type IRouter } from "express";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import {
  clientsTable,
  conversationMessagesTable,
  conversationsTable,
  db,
  pitchProjectsTable,
  usersTable,
} from "@workspace/db";
import { answerProjectQuestion } from "../lib/copilot";
import { verifyBrandSelectionToken } from "../lib/brand-selection-token";
import { createResearchRunWithConfirmedBrand } from "../lib/research-orchestrator";
import { loadProjectContext } from "../lib/research";
import {
  CreateProjectBody,
  CreateProjectResponse,
  GetDashboardResponse,
  GetProjectConversationParams,
  GetProjectConversationResponse,
  GetProjectParams,
  GetProjectResponse,
  GetProjectWorkspaceParams,
  GetProjectWorkspaceResponse,
  ListProjectsResponse,
  SendProjectMessageBody,
  SendProjectMessageParams,
  SendProjectMessageResponse,
  UpdateProjectBody,
  UpdateProjectParams,
  UpdateProjectResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();
// SECURITY: no authentication/authorization exists yet. Every request acts as this single
// workspace owner and owner_id is never checked. Internal/private deployment only; auth MUST be
// implemented before any public or multi-user production deployment (see README "Security status").
const DEMO_OWNER_ID = "11111111-1111-4111-8111-111111111111";

export async function ensureWorkspaceOwner(): Promise<void> {
  await db
    .insert(usersTable)
    .values({
      id: DEMO_OWNER_ID,
      displayName: "SkyBlue Strategist",
      email: "demo@pitch-intelligence.local",
    })
    .onConflictDoNothing();
}

const projectSelect = {
  id: pitchProjectsTable.id,
  clientId: pitchProjectsTable.clientId,
  clientName: sql<string>`coalesce(${pitchProjectsTable.canonicalBrandName}, ${clientsTable.name})`,
  title: pitchProjectsTable.title,
  market: pitchProjectsTable.market,
  campaignGeography: pitchProjectsTable.campaignGeography,
  campaignAreas: pitchProjectsTable.campaignAreas,
  category: pitchProjectsTable.category,
  pitchObjective: pitchProjectsTable.pitchObjective,
  productFocus: pitchProjectsTable.productFocus,
  regionalEntity: pitchProjectsTable.regionalEntity,
  preferredMedia: pitchProjectsTable.preferredMedia,
  targetQuantity: pitchProjectsTable.targetQuantity,
  stage: pitchProjectsTable.stage,
  status: pitchProjectsTable.status,
  isDemo: pitchProjectsTable.isDemo,
  createdAt: pitchProjectsTable.createdAt,
  updatedAt: pitchProjectsTable.updatedAt,
};

const CAMPAIGN_GEOGRAPHIES = ["DUBAI", "ABU_DHABI", "UAE", "CUSTOM"] as const;
type CampaignGeography = (typeof CAMPAIGN_GEOGRAPHIES)[number];

function normalizeCampaignAreas(areas: string[] | undefined): string[] | null {
  if (areas === undefined) return [];
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const area of areas) {
    const trimmed = area.trim();
    if (trimmed.length < 2 || trimmed.length > 80) return null;
    const key = trimmed.toLowerCase();
    if (!seen.has(key)) {
      normalized.push(trimmed);
      seen.add(key);
    }
  }
  return normalized;
}

function validCampaignGeography(
  geography: CampaignGeography,
  areas: string[],
): boolean {
  return geography === "CUSTOM" ? areas.length > 0 : areas.length === 0;
}

async function findProject(id: string) {
  const [project] = await db
    .select(projectSelect)
    .from(pitchProjectsTable)
    .innerJoin(clientsTable, eq(pitchProjectsTable.clientId, clientsTable.id))
    .where(eq(pitchProjectsTable.id, id));
  return project;
}

router.get("/dashboard", async (_req, res): Promise<void> => {
  await ensureWorkspaceOwner();
  const [counts] = await db
    .select({
      totalProjectCount: sql<number>`count(*)::int`,
      activeProjectCount: sql<number>`count(*) filter (where ${pitchProjectsTable.status} = 'active')::int`,
    })
    .from(pitchProjectsTable);
  const [researching] = await db.select({
    count: sql<number>`(
      select count(*)::int from (
        select distinct on (project_id) project_id, status
        from research_runs where scope <> 'sample_fixture_v1'
        order by project_id, requested_at desc
      ) latest where latest.status in ('queued', 'running')
    )`,
  }).from(pitchProjectsTable).limit(1);
  const [pitchReady] = await db.select({
    count: sql<number>`count(*)::int`,
  }).from(pitchProjectsTable).where(and(
    eq(pitchProjectsTable.stage, "pitch"),
    eq(pitchProjectsTable.status, "active"),
  ));
  const recentProjects = await db
    .select(projectSelect)
    .from(pitchProjectsTable)
    .innerJoin(clientsTable, eq(pitchProjectsTable.clientId, clientsTable.id))
    .orderBy(desc(pitchProjectsTable.updatedAt))
    .limit(6);
  res.json(GetDashboardResponse.parse({
    ...counts,
    researchInProgressCount: researching.count,
    pitchReadyCount: pitchReady.count,
    recentProjects,
  }));
});

router.get("/projects", async (_req, res): Promise<void> => {
  await ensureWorkspaceOwner();
  const projects = await db
    .select(projectSelect)
    .from(pitchProjectsTable)
    .innerJoin(clientsTable, eq(pitchProjectsTable.clientId, clientsTable.id))
    .orderBy(desc(pitchProjectsTable.updatedAt));
  res.json(ListProjectsResponse.parse(projects));
});

router.post("/projects", async (req, res): Promise<void> => {
  await ensureWorkspaceOwner();
  const parsed = CreateProjectBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  let selected: ReturnType<typeof verifyBrandSelectionToken> | undefined;
  if (parsed.data.brandSelectionToken) {
    try {
      selected = verifyBrandSelectionToken(parsed.data.brandSelectionToken);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Invalid brand selection token" });
      return;
    }
  }
  const option = selected?.option;
  const companyName = option
    ? option.kind === "company" ? option.name : option.parent ?? (option.kind === "brand" ? option.name : null)
    : parsed.data.clientName.trim();
  if (!companyName) {
    res.status(400).json({ error: "The selected brand or category has no validated parent company" });
    return;
  }
  const campaignGeography = parsed.data.campaignGeography ?? "DUBAI";
  const campaignAreas = normalizeCampaignAreas(parsed.data.campaignAreas);
  if (
    campaignAreas === null ||
    !validCampaignGeography(campaignGeography, campaignAreas)
  ) {
    res.status(400).json({
      error: "Custom campaign geography requires valid areas; preset geographies must not include areas",
    });
    return;
  }
  if (selected && (!parsed.data.pitchObjective || !parsed.data.preferredMedia)) {
    res.status(400).json({ error: "Choose a pitch objective and preferred media before research begins" });
    return;
  }
  const canonicalBrandName = option
    ? option.kind === "brand" ? option.name : companyName
    : null;
  const category = option
    ? option.kind === "category" ? option.name : option.category
    : parsed.data.category?.trim() || null;
  const productFocus = option
    ? option.kind === "company" ? null : option.name
    : parsed.data.productFocus?.trim() || null;
  const normalizedName = companyName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const [existingClient] = await db
    .select()
    .from(clientsTable)
    .where(eq(clientsTable.normalizedName, normalizedName));
  const client =
    existingClient ??
    (
      await db
        .insert(clientsTable)
        .values({
          name: companyName.trim(),
          normalizedName,
          market: parsed.data.market.trim(),
          category,
        })
        .returning()
    )[0];
  const [record] = await db
    .insert(pitchProjectsTable)
    .values({
      ownerId: DEMO_OWNER_ID,
      clientId: client.id,
      title: `${canonicalBrandName ?? client.name} OOH Opportunity`,
      market: parsed.data.market.trim(),
      campaignGeography,
      campaignAreas,
      category,
      pitchObjective: parsed.data.pitchObjective?.trim() || null,
      productFocus,
      preferredMedia: parsed.data.preferredMedia ?? null,
      targetQuantity: parsed.data.targetQuantity ?? null,
      enteredBrandName: selected?.query ?? parsed.data.clientName.trim(),
      canonicalBrandName,
      officialWebsite: option?.website ?? null,
      regionalEntity: option?.regionalEntity?.name ?? null,
      isDemo: false,
    })
    .returning();
  await db.insert(conversationsTable).values({
    projectId: record.id,
    title: `${canonicalBrandName ?? client.name} Project Copilot`,
  });
  if (selected && option) {
    try {
      const projectContext = await loadProjectContext(record.id);
      if (!projectContext) throw new Error("The created project could not be loaded for research");
      await createResearchRunWithConfirmedBrand(projectContext, {
        name: canonicalBrandName ?? companyName,
        website: option.website,
        parent: option.parent,
        category: option.kind === "category" ? option.name : option.category,
        sourceUrl: option.sourceUrl,
        evidenceQuote: option.evidenceQuote,
      });
    } catch (error) {
      res.status(503).json({
        error: `Project ${record.id} was created, but its selected-brand research run could not be queued: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
        projectId: record.id,
        recovery: {
          method: "POST",
          path: `/api/projects/${record.id}/research/refresh`,
          note: "Retry research for this saved project; brand confirmation may be required.",
        },
      });
      return;
    }
  }
  const project = await findProject(record.id);
  res.status(201).json(CreateProjectResponse.parse(project));
});

router.get("/projects/:id", async (req, res): Promise<void> => {
  await ensureWorkspaceOwner();
  const params = GetProjectParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const project = await findProject(params.data.id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  res.json(GetProjectResponse.parse(project));
});

router.patch("/projects/:id", async (req, res): Promise<void> => {
  const params = UpdateProjectParams.safeParse(req.params);
  const body = UpdateProjectBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Invalid project update" });
    return;
  }
  const [current] = await db
    .select({
      campaignGeography: pitchProjectsTable.campaignGeography,
      campaignAreas: pitchProjectsTable.campaignAreas,
    })
    .from(pitchProjectsTable)
    .where(eq(pitchProjectsTable.id, params.data.id));
  if (!current) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const campaignGeography = body.data.campaignGeography ?? current.campaignGeography;
  const campaignAreas = normalizeCampaignAreas(body.data.campaignAreas ?? current.campaignAreas);
  if (
    campaignAreas === null ||
    !validCampaignGeography(campaignGeography, campaignAreas)
  ) {
    res.status(400).json({
      error: "Custom campaign geography requires valid areas; preset geographies must not include areas",
    });
    return;
  }
  const [updated] = await db
    .update(pitchProjectsTable)
    .set({ ...body.data, campaignGeography, campaignAreas })
    .where(eq(pitchProjectsTable.id, params.data.id))
    .returning();
  if (!updated) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const project = await findProject(updated.id);
  res.json(UpdateProjectResponse.parse(project));
});

router.get("/projects/:id/workspace", async (req, res): Promise<void> => {
  await ensureWorkspaceOwner();
  const params = GetProjectWorkspaceParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const project = await findProject(params.data.id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const isTalabat = project.clientName === "Talabat";
  const workspace = {
    project,
    insight: isTalabat
      ? "A neighborhood-led OOH story could connect everyday convenience with high-frequency commuter moments."
      : `Start by validating ${project.clientName}'s current priorities before shaping an OOH opportunity.`,
    marketSnapshot: `${project.market} • ${project.category ?? "Category to confirm"} • Initial workspace`,
    competitorCount: null,
    lastKnownOohActivity: null,
    recommendedMedia: isTalabat ? ["Bus shelters", "Transit media", "Digital screens"] : [],
    locationsSummary: "Location planning is intentionally reserved for Milestone 4.",
    opportunitySummary: isTalabat
      ? "Explore high-frequency urban touchpoints, then validate the business trigger and competitive whitespace."
      : "Research and validate the client context before approving a strategic direction.",
    demoNotice: project.isDemo
      ? "Sample workspace content for interface review only. It is not verified client intelligence."
      : null,
  };
  res.json(GetProjectWorkspaceResponse.parse(workspace));
});

router.get("/projects/:id/conversation", async (req, res): Promise<void> => {
  await ensureWorkspaceOwner();
  const params = GetProjectConversationParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [conversation] = await db
    .select()
    .from(conversationsTable)
    .where(eq(conversationsTable.projectId, params.data.id));
  if (!conversation) {
    res.status(404).json({ error: "Conversation not found" });
    return;
  }
  const messages = await db
    .select()
    .from(conversationMessagesTable)
    .where(eq(conversationMessagesTable.conversationId, conversation.id))
    .orderBy(asc(conversationMessagesTable.createdAt));
  res.json(GetProjectConversationResponse.parse({ conversation, messages }));
});

router.post("/projects/:id/messages", async (req, res): Promise<void> => {
  const params = SendProjectMessageParams.safeParse(req.params);
  const body = SendProjectMessageBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Invalid message" });
    return;
  }
  const [conversation] = await db
    .select()
    .from(conversationsTable)
    .where(eq(conversationsTable.projectId, params.data.id));
  if (!conversation) {
    res.status(404).json({ error: "Conversation not found" });
    return;
  }
  const [userMessage] = await db
    .insert(conversationMessagesTable)
    .values({
      conversationId: conversation.id,
      role: "user",
      content: body.data.content.trim(),
    })
    .returning();
  const response = await answerProjectQuestion(params.data.id, body.data.content.trim());
  const [assistantMessage] = await db
    .insert(conversationMessagesTable)
    .values({
      conversationId: conversation.id,
      role: "assistant",
      content: response.text,
      isPlaceholder: response.isPlaceholder,
    })
    .returning();
  await db
    .update(conversationsTable)
    .set({ updatedAt: new Date() })
    .where(and(eq(conversationsTable.id, conversation.id), eq(conversationsTable.projectId, params.data.id)));
  res.status(201).json(
    SendProjectMessageResponse.parse({ userMessage, assistantMessage }),
  );
});

export default router;