import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { trainingEconomicsService, type TrainingEconomicsService } from "../services/training-economics.js";
import { assertCompanyAccess } from "./authz.js";

export type TrainingEconomicsRouteOptions = {
  service?: TrainingEconomicsService;
};

export function trainingEconomicsRoutes(db: Db, opts: TrainingEconomicsRouteOptions = {}) {
  const router = Router();
  const svc = opts.service ?? trainingEconomicsService(db);

  router.get("/companies/:companyId/training-economics", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const summary = await svc.dashboard(companyId);
    res.json(summary);
  });

  return router;
}
