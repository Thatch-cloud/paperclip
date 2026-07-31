import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { assertCompanyAccess } from "./authz.js";
import {
  createFineTuneConcurrencyLimiter,
  createFineTuneEntitlementService,
  createFineTuneRateLimiter,
  createInMemoryFineTuneStore,
  fineTuneSubmissionSchema,
  type FineTuneConcurrencyLimiter,
  type FineTuneEntitlementService,
  type FineTuneRateLimiter,
  type FineTuneStore,
} from "../services/fine-tune-entitlement.js";
import {
  createFineTunePricingService,
  flipEvaluationRequestSchema,
  type FineTunePricingService,
} from "../services/fine-tune-pricing.js";
import { HttpError } from "../errors.js";

export type FineTuneServiceOptions = {
  store?: FineTuneStore;
  rateLimiter?: FineTuneRateLimiter;
  concurrencyLimiter?: FineTuneConcurrencyLimiter;
  entitlementService?: FineTuneEntitlementService;
  pricingService?: FineTunePricingService;
};

export function createDefaultFineTuneService(): FineTuneEntitlementService {
  const store = createInMemoryFineTuneStore();
  const rateLimiter = createFineTuneRateLimiter({ maxRequests: 10, windowMs: 60_000 });
  const concurrencyLimiter = createFineTuneConcurrencyLimiter({ maxConcurrent: 2 });
  return createFineTuneEntitlementService({ store, rateLimiter, concurrencyLimiter });
}

export function fineTuneRoutes(_db: Db, opts: FineTuneServiceOptions = {}) {
  const service = opts.entitlementService ?? createDefaultFineTuneService();
  const pricingService = opts.pricingService ?? createFineTunePricingService();

  const router = Router();

  router.post("/companies/:companyId/fine-tunes", async (req: Request, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    try {
      const job = service.submit(companyId, req.body);
      res.status(202).json({
        id: job.id,
        status: job.status,
        residency: job.residency,
      });
    } catch (error) {
      if (error instanceof HttpError) {
        res.status(error.status).json({ error: error.message, ...((error.details as object) ?? {}) });
        return;
      }
      throw error;
    }
  });

  router.post("/companies/:companyId/fine-tunes/flip-evaluation", async (req: Request, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const parseResult = flipEvaluationRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(422).json({ error: "Invalid flip-evaluation request", details: parseResult.error.errors });
      return;
    }

    const decision = pricingService.evaluate(parseResult.data);
    res.status(200).json(decision);
  });

  router.get("/companies/:companyId/fine-tunes/:jobId", async (req: Request, res) => {
    const companyId = req.params.companyId as string;
    const jobId = req.params.jobId as string;
    assertCompanyAccess(req, companyId);

    const job = service.getJob(companyId, jobId);
    if (!job) {
      res.status(404).json({ error: "Fine-tune job not found" });
      return;
    }

    res.status(200).json({
      id: job.id,
      companyId: job.companyId,
      datasetId: job.datasetId,
      baseAdapterId: job.baseAdapterId,
      status: job.status,
      requestedAt: job.requestedAt.toISOString(),
      residency: job.residency,
    });
  });

  return router;
}

export { fineTuneSubmissionSchema };
