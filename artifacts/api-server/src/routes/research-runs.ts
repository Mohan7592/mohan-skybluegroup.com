import { Router, type IRouter } from "express";
import {
  ConfirmResearchBrandBody,
  ConfirmResearchBrandParams,
  ConfirmResearchBrandResponse,
  ConfirmResearchCompetitorsBody,
  ConfirmResearchCompetitorsParams,
  ConfirmResearchCompetitorsResponse,
  GetProjectResearchRunParams,
  GetProjectResearchRunResponse,
  ListProjectResearchRunsParams,
  ListProjectResearchRunsResponse,
  RetryResearchStagesBody,
  RetryResearchStagesParams,
  RetryResearchStagesResponse,
} from "@workspace/api-zod";
import {
  confirmBrand,
  confirmCompetitors,
  getRun,
  listRuns,
  retryRunStages,
  startDeepResearch,
} from "../lib/research-orchestrator";
import { loadProjectContext } from "../lib/research";

const router: IRouter = Router();

router.get("/projects/:id/research/runs", async (req, res): Promise<void> => {
  const params = ListProjectResearchRunsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid project ID" });
    return;
  }
  const project = await loadProjectContext(params.data.id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const runs = await listRuns(project.id);
  res.json(ListProjectResearchRunsResponse.parse(runs));
});

router.get("/projects/:id/research/runs/:runId", async (req, res): Promise<void> => {
  const params = GetProjectResearchRunParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid project or run ID" });
    return;
  }
  const project = await loadProjectContext(params.data.id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const run = await getRun(project.id, params.data.runId);
  if (!run) {
    res.status(404).json({ error: "Research run not found" });
    return;
  }
  res.json(GetProjectResearchRunResponse.parse(run));
});

router.post("/projects/:id/research/runs/:runId/confirm-brand", async (req, res): Promise<void> => {
  const params = ConfirmResearchBrandParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid project or run ID" });
    return;
  }
  const body = ConfirmResearchBrandBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const project = await loadProjectContext(params.data.id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  try {
    await confirmBrand(project, params.data.runId, body.data.website);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not confirm brand";
    const status = message.includes("not found") ? 404 : 409;
    res.status(status).json({ error: message });
    return;
  }
  const run = await getRun(project.id, params.data.runId);
  if (!run) {
    res.status(404).json({ error: "Research run not found" });
    return;
  }
  res.json(ConfirmResearchBrandResponse.parse(run));
});

router.put("/projects/:id/research/runs/:runId/competitors", async (req, res): Promise<void> => {
  const params = ConfirmResearchCompetitorsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid project or run ID" });
    return;
  }
  const body = ConfirmResearchCompetitorsBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const project = await loadProjectContext(params.data.id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  try {
    await confirmCompetitors(project, params.data.runId, body.data.names);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not confirm competitors";
    const status = message.includes("not found") ? 404 : 409;
    res.status(status).json({ error: message });
    return;
  }
  const run = await getRun(project.id, params.data.runId);
  if (!run) {
    res.status(404).json({ error: "Research run not found" });
    return;
  }
  res.json(ConfirmResearchCompetitorsResponse.parse(run));
});

router.post("/projects/:id/research/runs/:runId/deep-research", async (req, res): Promise<void> => {
  const params = GetProjectResearchRunParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid project or run ID" });
    return;
  }
  const project = await loadProjectContext(params.data.id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  try {
    const run = await startDeepResearch(project, params.data.runId);
    if (!run) {
      res.status(404).json({ error: "Research run not found" });
      return;
    }
    res.json(GetProjectResearchRunResponse.parse(run));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not start deep research";
    const status = message.includes("not found") ? 404 : 409;
    res.status(status).json({ error: message });
  }
});

router.post("/projects/:id/research/runs/:runId/retry", async (req, res): Promise<void> => {
  const params = RetryResearchStagesParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid project or run ID" });
    return;
  }
  const body = RetryResearchStagesBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const project = await loadProjectContext(params.data.id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  try {
    const run = await retryRunStages(project, params.data.runId, body.data.stages);
    res.json(RetryResearchStagesResponse.parse(run));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not retry research stages";
    const status = message.includes("not found") ? 404 : 409;
    res.status(status).json({ error: message });
  }
});

export default router;