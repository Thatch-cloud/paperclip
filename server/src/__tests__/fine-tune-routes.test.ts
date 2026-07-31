import express from "express";
import type { Request } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { fineTuneRoutes } from "../routes/fine-tune.js";
import {
  createFineTuneConcurrencyLimiter,
  createFineTuneEntitlementService,
  createFineTuneRateLimiter,
  createInMemoryFineTuneStore,
  type FineTuneEntitlementService,
} from "../services/fine-tune-entitlement.js";

function createTestApp(service: FineTuneEntitlementService) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res, next) => {
    req.actor = {
      type: "board",
      userId: "user-1",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: true,
    };
    next();
  });
  app.use("/api", fineTuneRoutes({} as never, { entitlementService: service }));
  return app;
}

function makeService() {
  const store = createInMemoryFineTuneStore();
  store.setEntitlement("company-1", {
    enabled: true,
    quotaJobsPerWeek: 2,
    rateLimitRequestsPerMinute: 10,
    concurrencyLimit: 2,
  });
  const service = createFineTuneEntitlementService({
    store,
    rateLimiter: createFineTuneRateLimiter({ maxRequests: 10, windowMs: 60_000 }),
    concurrencyLimiter: createFineTuneConcurrencyLimiter({ maxConcurrent: 2 }),
    now: () => new Date("2026-07-31T00:00:00.000Z"),
    generateId: () => "job-1",
    residency: { datasetRegion: "ap-southeast-2", adapterRegion: "ap-southeast-2" },
  });
  return service;
}

describe("fine-tune routes", () => {
  it("accepts a managed fine-tune job and returns residency guarantees", async () => {
    const app = createTestApp(makeService());
    const res = await request(app)
      .post("/api/companies/company-1/fine-tunes")
      .send({ datasetId: "dataset-a", baseAdapterId: "adapter-a" })
      .expect(202);
    expect(res.body).toMatchObject({
      id: "job-1",
      status: "queued",
      residency: {
        datasetRegion: "ap-southeast-2",
        adapterRegion: "ap-southeast-2",
      },
    });
  });

  it("returns 403 when the org is not entitled", async () => {
    const store = createInMemoryFineTuneStore();
    store.setEntitlement("company-1", {
      enabled: false,
      quotaJobsPerWeek: 10,
      rateLimitRequestsPerMinute: 10,
      concurrencyLimit: 2,
    });
    const service = createFineTuneEntitlementService({ store, now: () => new Date("2026-07-31T00:00:00.000Z") });
    const app = createTestApp(service);

    const res = await request(app)
      .post("/api/companies/company-1/fine-tunes")
      .send({ datasetId: "dataset-a", baseAdapterId: "adapter-a" })
      .expect(403);
    expect(res.body.error).toBe("Managed fine-tuning is not enabled for this organization");
  });

  it("returns 429 when the weekly quota is exceeded", async () => {
    const service = makeService();
    const app = createTestApp(service);

    await request(app).post("/api/companies/company-1/fine-tunes").send({ datasetId: "d1", baseAdapterId: "a1" }).expect(202);
    await request(app).post("/api/companies/company-1/fine-tunes").send({ datasetId: "d2", baseAdapterId: "a2" }).expect(202);
    const res = await request(app)
      .post("/api/companies/company-1/fine-tunes")
      .send({ datasetId: "d3", baseAdapterId: "a3" })
      .expect(429);
    expect(res.body.code).toBe("quota_exceeded");
  });

  it("returns 403 for payloads containing customer-provided code", async () => {
    const app = createTestApp(makeService());
    const res = await request(app)
      .post("/api/companies/company-1/fine-tunes")
      .send({ datasetId: "dataset-a", baseAdapterId: "adapter-a", script: "print(1)" })
      .expect(403);
    expect(res.body.error).toContain("Customer-provided code");
  });

  it("returns 404 when requesting a job from another company", async () => {
    const service = makeService();
    const job = service.submit("company-1", { datasetId: "dataset-a", baseAdapterId: "adapter-a" });
    const app = createTestApp(service);

    await request(app).get(`/api/companies/company-2/fine-tunes/${job.id}`).expect(404);
  });

  it("returns the job status and residency", async () => {
    const service = makeService();
    const job = service.submit("company-1", { datasetId: "dataset-a", baseAdapterId: "adapter-a" });
    const app = createTestApp(service);

    const res = await request(app).get(`/api/companies/company-1/fine-tunes/${job.id}`).expect(200);
    expect(res.body).toMatchObject({
      id: job.id,
      companyId: "company-1",
      datasetId: "dataset-a",
      baseAdapterId: "adapter-a",
      status: "queued",
      residency: { datasetRegion: "ap-southeast-2", adapterRegion: "ap-southeast-2" },
    });
  });

  describe("flip-evaluation", () => {
    it("returns justified when training margin meets the opportunity-cost floor", async () => {
      const app = createTestApp(makeService());
      const res = await request(app)
        .post("/api/companies/company-1/fine-tunes/flip-evaluation")
        .send({
          unit: { type: "node", unitId: "node-1" },
          trainingMarginPerUnitHourCents: 120,
          servingOpportunityCostPerUnitHourCents: 100,
          provenance: "durable",
        })
        .expect(200);

      expect(res.body.verdict).toBe("justified");
      expect(res.body.belowFloor).toBe(false);
      expect(res.body.floorCents).toBe(100);
    });

    it("returns not_justified when training margin is below the opportunity-cost floor", async () => {
      const app = createTestApp(makeService());
      const res = await request(app)
        .post("/api/companies/company-1/fine-tunes/flip-evaluation")
        .send({
          unit: { type: "node", unitId: "node-1" },
          trainingMarginPerUnitHourCents: 80,
          servingOpportunityCostPerUnitHourCents: 100,
          provenance: "durable",
        })
        .expect(200);

      expect(res.body.verdict).toBe("not_justified");
      expect(res.body.belowFloor).toBe(true);
    });

    it("returns insufficient_data for modelled inputs", async () => {
      const app = createTestApp(makeService());
      const res = await request(app)
        .post("/api/companies/company-1/fine-tunes/flip-evaluation")
        .send({
          unit: { type: "mig_slice", unitId: "mig-1" },
          trainingMarginPerUnitHourCents: 120,
          servingOpportunityCostPerUnitHourCents: 100,
          provenance: "modelled",
        })
        .expect(200);

      expect(res.body.verdict).toBe("insufficient_data");
      expect(res.body.reasons[0]).toContain("durable ledger/projection rows");
    });

    it("returns 422 for an invalid flip-evaluation request", async () => {
      const app = createTestApp(makeService());
      const res = await request(app)
        .post("/api/companies/company-1/fine-tunes/flip-evaluation")
        .send({
          unit: { type: "node" },
          trainingMarginPerUnitHourCents: -1,
          servingOpportunityCostPerUnitHourCents: 100,
          provenance: "durable",
        })
        .expect(422);

      expect(res.body.error).toBe("Invalid flip-evaluation request");
      expect(res.body.details).toBeDefined();
    });
  });
});
