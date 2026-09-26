import { Router, type IRouter } from "express";
import {
  GetProjectIntelligenceParams,
  GetProjectIntelligenceResponse,
  RefreshProjectResearchParams,
  RefreshProjectResearchResponse,
} from "@workspace/api-zod";
import { db, pitchProjectsTable, researchRunsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { ensureWorkspaceOwner } from "./projects";
import { getProjectIntelligence, loadProjectContext } from "../lib/research";
import { createResearchRun, isResearchConfigured } from "../lib/research-orchestrator";
import { canRefreshProjectResearch } from "../lib/research-orchestrator-rules";

const router: IRouter = Router();

router.get("/projects/:id/intelligence", async (req, res): Promise<void> => {
  const params = GetProjectIntelligenceParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid project ID" });
    return;
  }
  await ensureWorkspaceOwner();
  const project = await loadProjectContext(params.data.id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const intelligence = await getProjectIntelligence(project);
  res.json(GetProjectIntelligenceResponse.parse(intelligence));
});

router.post("/projects/:id/research/refresh", async (req, res): Promise<void> => {
  const params = RefreshProjectResearchParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid project ID" });
    return;
  }
  const project = await loadProjectContext(params.data.id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const [projectSetup] = await db.select({
    preferredMedia: pitchProjectsTable.preferredMedia,
  }).from(pitchProjectsTable).where(eq(pitchProjectsTable.id, project.id));
  const [historicalRun] = await db.select({ id: researchRunsTable.id }).from(researchRunsTable)
    .where(eq(researchRunsTable.projectId, project.id)).limit(1);
  if (!canRefreshProjectResearch({
    hasHistoricalRuns: !!historicalRun,
    confirmedBrandName: project.canonicalBrandName,
    officialWebsite: project.officialWebsite,
    market: project.market,
    category: project.category,
    productFocus: project.productFocus,
    pitchObjective: project.pitchObjective,
    preferredMedia: projectSetup?.preferredMedia ?? null,
  })) {
    res.status(409).json({
      error: "Confirm the brand and complete market/category, pitch objective, and preferred media before starting research.",
    });
    return;
  }
  if (!isResearchConfigured()) {
    res.status(503).json({ error: "Live research is not configured. Sample data has not been refreshed." });
    return;
  }
  const run = await createResearchRun(project);
  res.status(202).json(RefreshProjectResearchResponse.parse(run));
});

export default router;