import { z } from "zod";

export const flipUnitTypeSchema = z.enum(["node", "mig_slice"]);
export type FlipUnitType = z.infer<typeof flipUnitTypeSchema>;

export const flipUnitSchema = z.object({
  type: flipUnitTypeSchema,
  unitId: z.string().min(1),
  label: z.string().optional(),
});
export type FlipUnit = z.infer<typeof flipUnitSchema>;

export const flipInputProvenanceSchema = z.enum(["durable", "modelled"]);
export type FlipInputProvenance = z.infer<typeof flipInputProvenanceSchema>;

export const flipOverrideSchema = z.object({
  actorId: z.string().min(1),
  reason: z.string().min(1),
  timestamp: z.union([z.string().datetime(), z.date()]),
});
export type FlipOverride = z.infer<typeof flipOverrideSchema>;

export const flipEvaluationRequestSchema = z.object({
  unit: flipUnitSchema,
  trainingMarginPerUnitHourCents: z.number().int().min(0),
  servingOpportunityCostPerUnitHourCents: z.number().int().min(0),
  provenance: flipInputProvenanceSchema,
  override: flipOverrideSchema.optional(),
});
export type FlipEvaluationRequest = z.infer<typeof flipEvaluationRequestSchema>;

export type FlipDecisionVerdict = "justified" | "not_justified" | "insufficient_data";

export type FlipDecision = {
  unit: FlipUnit;
  verdict: FlipDecisionVerdict;
  trainingMarginPerUnitHourCents: number;
  servingOpportunityCostPerUnitHourCents: number;
  floorCents: number;
  effectiveTrainingMarginCents: number;
  belowFloor: boolean;
  reasons: string[];
  override?: {
    actorId: string;
    reason: string;
    timestamp: string;
  };
};

export type FineTunePricingService = {
  evaluate(request: FlipEvaluationRequest): FlipDecision;
};

function normalizeTimestamp(value: string | Date): string {
  return typeof value === "string" ? value : value.toISOString();
}

/**
 * Decide whether flipping a node or MIG-slice unit from serving to managed fine-tune training is
 * economically justified. The comparison is between durable training margin per unit-hour and the
 * durable Instant/Batch serving revenue the same unit would forgo.
 *
 * The rule is intentionally conservative: a flip is only "justified" when the training margin is at
 * or above the serving opportunity-cost floor. A below-floor price requires an explicit override with
 * a durable actor/reason/timestamp record.
 *
 * Non-durable (modelled) inputs are never silently used; they produce an "insufficient_data" verdict.
 */
export function evaluateFlip(request: FlipEvaluationRequest): FlipDecision {
  const floorCents = request.servingOpportunityCostPerUnitHourCents;
  const reasons: string[] = [];

  if (request.provenance !== "durable") {
    reasons.push(
      "Inputs are not sourced from durable ledger/projection rows; the flip decision requires durable data.",
    );
    return {
      unit: request.unit,
      verdict: "insufficient_data",
      trainingMarginPerUnitHourCents: request.trainingMarginPerUnitHourCents,
      servingOpportunityCostPerUnitHourCents: request.servingOpportunityCostPerUnitHourCents,
      floorCents,
      effectiveTrainingMarginCents: request.trainingMarginPerUnitHourCents,
      belowFloor: false,
      reasons,
    };
  }

  const belowFloor = request.trainingMarginPerUnitHourCents < floorCents;
  let verdict: FlipDecisionVerdict;
  let overrideRecord: FlipDecision["override"] = undefined;

  if (belowFloor) {
    if (request.override) {
      verdict = "justified";
      overrideRecord = {
        actorId: request.override.actorId,
        reason: request.override.reason,
        timestamp: normalizeTimestamp(request.override.timestamp),
      };
      reasons.push(
        `Training margin ${request.trainingMarginPerUnitHourCents}c/unit-hour is below the serving opportunity-cost floor ${floorCents}c/unit-hour; accepted via explicit override by ${request.override.actorId}.`,
      );
    } else {
      verdict = "not_justified";
      reasons.push(
        `Training margin ${request.trainingMarginPerUnitHourCents}c/unit-hour is below the serving opportunity-cost floor ${floorCents}c/unit-hour; flip is not economically justified without an explicit override.`,
      );
    }
  } else {
    verdict = "justified";
    reasons.push(
      `Training margin ${request.trainingMarginPerUnitHourCents}c/unit-hour meets or exceeds the serving opportunity-cost floor ${floorCents}c/unit-hour; flip is economically justified.`,
    );
  }

  return {
    unit: request.unit,
    verdict,
    trainingMarginPerUnitHourCents: request.trainingMarginPerUnitHourCents,
    servingOpportunityCostPerUnitHourCents: request.servingOpportunityCostPerUnitHourCents,
    floorCents,
    effectiveTrainingMarginCents: request.trainingMarginPerUnitHourCents,
    belowFloor,
    reasons,
    override: overrideRecord,
  };
}

export function createFineTunePricingService(): FineTunePricingService {
  return {
    evaluate: evaluateFlip,
  };
}
