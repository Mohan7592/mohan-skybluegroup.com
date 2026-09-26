import { Router, type IRouter } from "express";
import healthRouter from "./health";
import projectsRouter from "./projects";
import intelligenceRouter from "./intelligence";
import researchRunsRouter from "./research-runs";
import claimReviewsRouter from "./claim-reviews";
import inventoryRouter from "./inventory";
import inventorySyncRouter from "./inventory-sync";
import busRoutesRouter from "./bus-routes";
import projectBusPlanRouter from "./project-bus-plan";
import locationIntelligenceRouter from "./location-intelligence";
import brandOptionsRouter from "./brand-options";
import passengerMetricsRouter from "./passenger-metrics";

const router: IRouter = Router();

router.use(healthRouter);
router.use(projectsRouter);
router.use(brandOptionsRouter);
router.use(passengerMetricsRouter);
router.use(intelligenceRouter);
router.use(researchRunsRouter);
router.use(claimReviewsRouter);
router.use(inventoryRouter);
router.use(inventorySyncRouter);
router.use(busRoutesRouter);
router.use(projectBusPlanRouter);
router.use(locationIntelligenceRouter);

export default router;
