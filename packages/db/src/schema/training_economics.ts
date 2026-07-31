import { pgTable, uuid, text, timestamp, integer, boolean, index, doublePrecision } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const trainingEconomicsProvenance = ["measured", "modelled"] as const;
export type TrainingEconomicsProvenance = (typeof trainingEconomicsProvenance)[number];

export const trainingEconomicsWorkloadType = [
  "managed_fine_tune",
  "inference",
  "spark_training",
] as const;
export type TrainingEconomicsWorkloadType = (typeof trainingEconomicsWorkloadType)[number];

export const trainingEconomicsFlipRecommendation = ["train", "inference", "hold"] as const;
export type TrainingEconomicsFlipRecommendation = (typeof trainingEconomicsFlipRecommendation)[number];

/**
 * Per-company training economics observations used to populate the operator dashboard.
 *
 * Each row represents one metric observation for a workload in a time period. The
 * dashboard service aggregates rows by company and period, grouping lane/node/
 * node-config dimensions where present. Provenance is carried per field.
 *
 * Spark training rows are stored for completeness but are explicitly excluded
 * from the financial benchmark aggregate.
 */
export const trainingEconomicsMetrics = pgTable(
  "training_economics_metrics",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
    workloadType: text("workload_type").notNull().default("managed_fine_tune"),
    jobId: text("job_id"),
    laneId: text("lane_id"),
    nodeId: text("node_id"),
    nodeConfigId: text("node_config_id"),
    unitHours: doublePrecision("unit_hours").notNull().default(0),
    unitHoursProvenance: text("unit_hours_provenance").notNull().default("modelled"),
    costCents: integer("cost_cents").notNull().default(0),
    costProvenance: text("cost_provenance").notNull().default("modelled"),
    revenueCents: integer("revenue_cents").notNull().default(0),
    revenueProvenance: text("revenue_provenance").notNull().default("modelled"),
    nodeUtilizationPercent: doublePrecision("node_utilization_percent"),
    nodeUtilizationProvenance: text("node_utilization_provenance").default("modelled"),
    flipRecommendation: text("flip_recommendation"),
    flipRecommendationProvenance: text("flip_recommendation_provenance").default("modelled"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyPeriodIdx: index("training_economics_metrics_company_period_idx").on(
      table.companyId,
      table.periodStart,
      table.periodEnd,
    ),
    companyWorkloadIdx: index("training_economics_metrics_company_workload_idx").on(
      table.companyId,
      table.workloadType,
    ),
  }),
);
