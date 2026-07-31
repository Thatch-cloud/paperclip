import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, trainingEconomicsMetrics } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { trainingEconomicsService } from "../services/training-economics.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres training economics service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("training economics service", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-training-economics-service-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(trainingEconomicsMetrics);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("aggregates provenance labels and excludes Spark training from the financial benchmark", async () => {
    const companyId = randomUUID();
    const otherCompanyId = randomUUID();

    await db.insert(companies).values([
      {
        id: companyId,
        name: "TrainingCo",
        issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: otherCompanyId,
        name: "OtherCo",
        issuePrefix: `T${otherCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
    ]);

    const now = new Date();
    const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 5));
    const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

    await db.insert(trainingEconomicsMetrics).values([
      // Managed fine-tune training on lane-a / node-1
      {
        id: randomUUID(),
        companyId,
        periodStart,
        periodEnd,
        workloadType: "managed_fine_tune",
        jobId: "job-1",
        laneId: "lane-a",
        nodeId: "node-1",
        nodeConfigId: "config-gpu-8x",
        unitHours: 120.5,
        unitHoursProvenance: "measured",
        costCents: 50_000,
        costProvenance: "measured",
        revenueCents: 75_000,
        revenueProvenance: "measured",
        nodeUtilizationPercent: 85.0,
        nodeUtilizationProvenance: "measured",
        flipRecommendation: "hold",
        flipRecommendationProvenance: "modelled",
      },
      // Inference on lane-a / node-1
      {
        id: randomUUID(),
        companyId,
        periodStart,
        periodEnd,
        workloadType: "inference",
        jobId: "job-2",
        laneId: "lane-a",
        nodeId: "node-1",
        nodeConfigId: "config-gpu-8x",
        unitHours: 40.0,
        unitHoursProvenance: "measured",
        costCents: 10_000,
        costProvenance: "measured",
        revenueCents: 20_000,
        revenueProvenance: "measured",
        nodeUtilizationPercent: 60.0,
        nodeUtilizationProvenance: "measured",
        flipRecommendation: "inference",
        flipRecommendationProvenance: "modelled",
      },
      // Spark training — must be excluded from financial benchmark
      {
        id: randomUUID(),
        companyId,
        periodStart,
        periodEnd,
        workloadType: "spark_training",
        jobId: "job-3",
        laneId: "lane-b",
        nodeId: "node-2",
        nodeConfigId: "config-cpu-32x",
        unitHours: 200.0,
        unitHoursProvenance: "measured",
        costCents: 30_000,
        costProvenance: "measured",
        revenueCents: 0,
        revenueProvenance: "modelled",
        nodeUtilizationPercent: 40.0,
        nodeUtilizationProvenance: "measured",
      },
      // Other company — must be ignored
      {
        id: randomUUID(),
        companyId: otherCompanyId,
        periodStart,
        periodEnd,
        workloadType: "managed_fine_tune",
        laneId: "lane-x",
        nodeId: "node-9",
        nodeConfigId: "config-gpu-8x",
        unitHours: 999.0,
        unitHoursProvenance: "measured",
        costCents: 999_999,
        costProvenance: "measured",
        revenueCents: 999_999,
        revenueProvenance: "measured",
      },
    ]);

    const dashboard = await trainingEconomicsService(db).dashboard(companyId);

    expect(dashboard.companyId).toBe(companyId);
    expect(dashboard.summary.unitHours).toEqual({ value: 160.5, provenance: "measured" });
    expect(dashboard.summary.totalCostCents).toEqual({ value: 60_000, provenance: "measured" });
    expect(dashboard.summary.totalRevenueCents).toEqual({ value: 95_000, provenance: "measured" });
    expect(dashboard.summary.marginCents).toEqual({ value: 35_000, provenance: "measured" });
    expect(dashboard.summary.marginPercent.value).toBeCloseTo(36.84, 1);
    expect(dashboard.summary.marginPercent.provenance).toBe("measured");

    expect(dashboard.marginsByLane).toContainEqual({
      laneId: "lane-a",
      costCents: 60_000,
      revenueCents: 95_000,
      marginCents: 35_000,
      marginPercent: 36.84,
      provenance: "measured",
    });

    expect(dashboard.nodeUtilization).toContainEqual({
      nodeConfigId: "config-gpu-8x",
      nodeId: "node-1",
      utilizationPercent: 72.5,
      provenance: "measured",
    });

    expect(dashboard.trainVsInference).toMatchObject({
      recommendation: "inference",
      trainUnitHours: 120.5,
      inferenceUnitHours: 40.0,
      provenance: "modelled",
    });

    expect(dashboard.financialBenchmark).toEqual({
      totalCostCents: 60_000,
      excludesSparkTraining: true,
      sparkTrainingCostCents: 30_000,
      provenance: "measured",
    });
  });

  it("falls back to modelled provenance when measured and modelled are mixed", async () => {
    const companyId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "MixedCo",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const now = new Date();
    const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 5));
    const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

    await db.insert(trainingEconomicsMetrics).values([
      {
        id: randomUUID(),
        companyId,
        periodStart,
        periodEnd,
        workloadType: "managed_fine_tune",
        laneId: "lane-mixed",
        nodeId: "node-1",
        nodeConfigId: "config-gpu-8x",
        unitHours: 10.0,
        unitHoursProvenance: "measured",
        costCents: 5_000,
        costProvenance: "measured",
        revenueCents: 10_000,
        revenueProvenance: "modelled",
        nodeUtilizationPercent: 80.0,
        nodeUtilizationProvenance: "measured",
      },
      {
        id: randomUUID(),
        companyId,
        periodStart,
        periodEnd,
        workloadType: "managed_fine_tune",
        laneId: "lane-mixed",
        nodeId: "node-1",
        nodeConfigId: "config-gpu-8x",
        unitHours: 5.0,
        unitHoursProvenance: "modelled",
        costCents: 2_500,
        costProvenance: "modelled",
        revenueCents: 5_000,
        revenueProvenance: "modelled",
        nodeUtilizationPercent: 60.0,
        nodeUtilizationProvenance: "modelled",
      },
    ]);

    const dashboard = await trainingEconomicsService(db).dashboard(companyId);

    expect(dashboard.summary.totalCostCents.provenance).toBe("modelled");
    expect(dashboard.summary.totalRevenueCents.provenance).toBe("modelled");
    expect(dashboard.summary.marginCents.provenance).toBe("modelled");
    expect(dashboard.marginsByLane[0].provenance).toBe("modelled");
    expect(dashboard.nodeUtilization[0].provenance).toBe("modelled");
  });
});
