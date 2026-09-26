import { Router, type IRouter } from "express";
import { GetBrandOptionsBody, GetBrandOptionsResponse } from "@workspace/api-zod";
import { isLiveResearchConfigured } from "../lib/live-research";
import { getBrandOptions } from "../lib/brand-options";
import { ensureWorkspaceOwner } from "./projects";

const router: IRouter = Router();

router.post("/brand-options", async (req, res): Promise<void> => {
  await ensureWorkspaceOwner();
  const parsed = GetBrandOptionsBody.safeParse(req.body);
  const query = parsed.success ? parsed.data.query.trim() : "";
  if (!parsed.success || !query) {
    res.status(400).json({ error: parsed.success ? "Query is required" : parsed.error.message });
    return;
  }
  if (!isLiveResearchConfigured()) {
    res.status(503).json({ error: "Live brand suggestions are not configured." });
    return;
  }
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new Error("Official source lookup timed out"));
    }, 25_000);
  });
  const onClose = () => { if (!res.writableEnded) controller.abort(); };
  res.on("close", onClose);
  try {
    const options = await Promise.race([getBrandOptions(query, controller.signal, (diagnostics) => {
      req.log.info({ brandOptionDiagnostics: diagnostics }, "Brand options discovery completed");
    }), deadline]);
    if (controller.signal.aborted || res.destroyed) return;
    res.json(GetBrandOptionsResponse.parse({ options }));
  } catch (error) {
    if (res.destroyed) return;
    const message = error instanceof Error ? error.message : "Brand suggestions could not be generated";
    const status = controller.signal.aborted ? 504 : message.includes("SESSION_SECRET") ? 503 : 502;
    res.status(status).json({ error: status === 504 ? "Official source lookup timed out. Try a more specific brand or official domain." : message });
  } finally {
    clearTimeout(timeout);
    res.off("close", onClose);
  }
});

export default router;