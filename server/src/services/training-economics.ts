import { and, eq, gte, lte, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companies, trainingEconomicsMetrics } from "@paperclipai/db";
import type { TrainingEconomicsSummary } from "@paperclipai/shared";
import { notFound } from "../errors.js";

const DASHBOARD_PERIOD_DAYS = 30;

function combineProvenance(values: string[]): "measured" | "modelled" {
  if (values.length === 0) return "modelled";
  if (values.every((v) => v === "measured")) return "measured";
  return "modelled";
}

function toIsoUtc(date: Date): string {
  return date.toISOString();
}

export function trainingEconomicsService(db: Db) {
  return {
    dashboard: async (companyId: string): Promise<TrainingEconomicsSummary> => {
      const company = await db
        .select()
        .from(companies)
        .where(eq(companies.id, companyId))
        .then((rows) => rows[0] ?? null);

      if (!company) throw notFound("Company not found");

      const now = new Date();
      const periodEnd = new Date(now.toISOString());
      const periodStart = new Date(
        Date.UTC(
          now.getUTCFullYear(),
          now.getUTCMonth(),
          now.getUTCDate() - DASHBOARD_PERIOD_DAYS,
        ),
      );

      const rows = await db
        .select()
        .from(trainingEconomicsMetrics)
        .where(
          and(
            eq(trainingEconomicsMetrics.companyId, companyId),
            gte(trainingEconomicsMetrics.periodStart, periodStart),
            lte(trainingEconomicsMetrics.periodEnd, periodEnd),
          ),
        );

      const nonSparkRows = rows.filter((row) => row.workloadType !== "spark_training");
      const sparkRows = rows.filter((row) => row.workloadType === "spark_training");

      const totalUnitHours = nonSparkRows.reduce((sum, row) => sum + (row.unitHours ?? 0), 0);
      const totalCostCents = nonSparkRows.reduce((sum, row) => sum + row.costCents, 0);
      const totalRevenueCents = nonSparkRows.reduce((sum, row) => sum + row.revenueCents, 0);
      const marginCents = totalRevenueCents - totalCostCents;
      const marginPercent = totalRevenueCents > 0 ? (marginCents / totalRevenueCents) * 100 : 0;

      const unitHoursProvenance = combineProvenance(nonSparkRows.map((r) => r.unitHoursProvenance));
      const costProvenance = combineProvenance(nonSparkRows.map((r) => r.costProvenance));
      const revenueProvenance = combineProvenance(nonSparkRows.map((r) => r.revenueProvenance));
      const summaryProvenance = combineProvenance([costProvenance, revenueProvenance]);

      const lanes = new Map<
        string,
        { costCents: number; revenueCents: number; provenances: string[] }
      >();
      for (const row of nonSparkRows) {
        if (!row.laneId) continue;
        const existing = lanes.get(row.laneId) ?? { costCents: 0, revenueCents: 0, provenances: [] };
        existing.costCents += row.costCents;
        existing.revenueCents += row.revenueCents;
        existing.provenances.push(row.costProvenance, row.revenueProvenance);
        lanes.set(row.laneId, existing);
      }
      const marginsByLane = Array.from(lanes.entries()).map(([laneId, agg]) => {
        const laneMarginCents = agg.revenueCents - agg.costCents;
        const laneMarginPercent = agg.revenueCents > 0 ? (laneMarginCents / agg.revenueCents) * 100 : 0;
        return {
          laneId,
          costCents: agg.costCents,
          revenueCents: agg.revenueCents,
          marginCents: laneMarginCents,
          marginPercent: Number(laneMarginPercent.toFixed(2)),
          provenance: combineProvenance(agg.provenances),
        };
      });

      const nodes = new Map<
        string,
        { utilizationSum: number; count: number; provenances: string[] }
      >();
      for (const row of nonSparkRows) {
        if (!row.nodeConfigId || !row.nodeId || row.nodeUtilizationPercent == null) continue;
        const key = `${row.nodeConfigId}::${row.nodeId}`;
        const existing = nodes.get(key) ?? { utilizationSum: 0, count: 0, provenances: [] };
        existing.utilizationSum += row.nodeUtilizationPercent;
        existing.count += 1;
        if (row.nodeUtilizationProvenance) {
          existing.provenances.push(row.nodeUtilizationProvenance);
        }
        nodes.set(key, existing);
      }
      const nodeUtilization = Array.from(nodes.entries()).map(([key, agg]) => {
        const [nodeConfigId, nodeId] = key.split("::");
        return {
          nodeConfigId,
          nodeId,
          utilizationPercent: Number((agg.utilizationSum / agg.count).toFixed(2)),
          provenance: combineProvenance(agg.provenances),
        };
      });

      const trainUnitHours = nonSparkRows
        .filter((r) => r.workloadType === "managed_fine_tune")
        .reduce((sum, r) => sum + (r.unitHours ?? 0), 0);
      const inferenceUnitHours = nonSparkRows
        .filter((r) => r.workloadType === "inference")
        .reduce((sum, r) => sum + (r.unitHours ?? 0), 0);

      let flipRecommendation: "train" | "inference" | "hold" = "hold";
      if (trainUnitHours > 0 || inferenceUnitHours > 0) {
        if (trainUnitHours > inferenceUnitHours * 1.2) {
          flipRecommendation = "inference";
        } else if (inferenceUnitHours > trainUnitHours * 1.2) {
          flipRecommendation = "train";
        } else {
          flipRecommendation = "hold";
        }
      }
      const flipProvenances = nonSparkRows
        .map((r) => r.flipRecommendationProvenance)
        .filter((p): p is string => p != null);
      const flipProvenance = combineProvenance(flipProvenances);

      const sparkTrainingCostCents = sparkRows.reduce((sum, row) => sum + row.costCents, 0);
      const financialBenchmarkCostCents = nonSparkRows.reduce((sum, row) => sum + row.costCents, 0);

      return {
        companyId,
        period: {
          start: toIsoUtc(periodStart),
          end: toIsoUtc(periodEnd),
        },
        summary: {
          unitHours: { value: Number(totalUnitHours.toFixed(2)), provenance: unitHoursProvenance },
          totalCostCents: { value: totalCostCents, provenance: costProvenance },
          totalRevenueCents: { value: totalRevenueCents, provenance: revenueProvenance },
          marginCents: { value: marginCents, provenance: summaryProvenance },
          marginPercent: { value: Number(marginPercent.toFixed(2)), provenance: summaryProvenance },
        },
        marginsByLane,
        nodeUtilization,
        trainVsInference: {
          recommendation: flipRecommendation,
          trainUnitHours: Number(trainUnitHours.toFixed(2)),
          inferenceUnitHours: Number(inferenceUnitHours.toFixed(2)),
          provenance: flipProvenance,
        },
        financialBenchmark: {
          totalCostCents: financialBenchmarkCostCents,
          excludesSparkTraining: true,
          sparkTrainingCostCents,
          provenance: costProvenance,
        },
      };
    },
  };
}

export type TrainingEconomicsService = ReturnType<typeof trainingEconomicsService>;
