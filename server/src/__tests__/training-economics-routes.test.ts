import express from "express";
import type { Request } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { errorHandler } from "../middleware/error-handler.js";
import { trainingEconomicsRoutes } from "../routes/training-economics.js";
import type { TrainingEconomicsService } from "../services/training-economics.js";

function createTestApp(service: TrainingEconomicsService, actorSource = "local_implicit") {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res, next) => {
    req.actor = {
      type: "board",
      userId: "user-1",
      companyIds: ["company-1"],
      source: actorSource,
      isInstanceAdmin: true,
    };
    next();
  });
  app.use("/api", trainingEconomicsRoutes({} as never, { service }));
  app.use(errorHandler);
  return app;
}

function makeService(summary: Awaited<ReturnType<TrainingEconomicsService["dashboard"]>>): TrainingEconomicsService {
  return {
    dashboard: async () => summary,
  };
}

describe("training economics routes", () => {
  it("returns the training economics dashboard for an authorized company", async () => {
    const summary: Awaited<ReturnType<TrainingEconomicsService["dashboard"]>> = {
      companyId: "company-1",
      period: { start: "2026-07-01T00:00:00.000Z", end: "2026-07-31T00:00:00.000Z" },
      summary: {
        unitHours: { value: 160.5, provenance: "measured" },
        totalCostCents: { value: 60_000, provenance: "measured" },
        totalRevenueCents: { value: 95_000, provenance: "measured" },
        marginCents: { value: 35_000, provenance: "measured" },
        marginPercent: { value: 36.84, provenance: "measured" },
      },
      marginsByLane: [
        {
          laneId: "lane-a",
          costCents: 60_000,
          revenueCents: 95_000,
          marginCents: 35_000,
          marginPercent: 36.84,
          provenance: "measured",
        },
      ],
      nodeUtilization: [
        {
          nodeConfigId: "config-gpu-8x",
          nodeId: "node-1",
          utilizationPercent: 72.5,
          provenance: "measured",
        },
      ],
      trainVsInference: {
        recommendation: "inference",
        trainUnitHours: 120.5,
        inferenceUnitHours: 40.0,
        provenance: "modelled",
      },
      financialBenchmark: {
        totalCostCents: 60_000,
        excludesSparkTraining: true,
        sparkTrainingCostCents: 30_000,
        provenance: "measured",
      },
    };

    const app = createTestApp(makeService(summary));
    const res = await request(app).get("/api/companies/company-1/training-economics").expect(200);
    expect(res.body).toEqual(summary);
  });

  it("returns 403 for a company the actor cannot access", async () => {
    const app = createTestApp(makeService({} as Awaited<ReturnType<TrainingEconomicsService["dashboard"]>>), "web");

    const res = await request(app).get("/api/companies/company-2/training-economics").expect(403);
    expect(res.body.error).toContain("does not have access");
  });
});
