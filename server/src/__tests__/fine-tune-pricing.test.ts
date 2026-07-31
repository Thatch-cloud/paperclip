import { describe, expect, it } from "vitest";
import { evaluateFlip, type FlipEvaluationRequest } from "../services/fine-tune-pricing.js";

function makeRequest(overrides: Partial<FlipEvaluationRequest> = {}): FlipEvaluationRequest {
  return {
    unit: { type: "node", unitId: "node-rtx-pro-6000-001" },
    trainingMarginPerUnitHourCents: 120,
    servingOpportunityCostPerUnitHourCents: 100,
    provenance: "durable",
    ...overrides,
  };
}

describe("fine-tune node-flip pricing", () => {
  it("justifies a flip when training margin meets the serving opportunity-cost floor", () => {
    const decision = evaluateFlip(makeRequest({ trainingMarginPerUnitHourCents: 120 }));

    expect(decision.verdict).toBe("justified");
    expect(decision.belowFloor).toBe(false);
    expect(decision.floorCents).toBe(100);
    expect(decision.effectiveTrainingMarginCents).toBe(120);
    expect(decision.override).toBeUndefined();
    expect(decision.reasons[0]).toContain("meets or exceeds");
  });

  it("does not justify a flip when training margin is below the serving opportunity-cost floor", () => {
    const decision = evaluateFlip(makeRequest({ trainingMarginPerUnitHourCents: 80 }));

    expect(decision.verdict).toBe("not_justified");
    expect(decision.belowFloor).toBe(true);
    expect(decision.floorCents).toBe(100);
    expect(decision.override).toBeUndefined();
    expect(decision.reasons[0]).toContain("below the serving opportunity-cost floor");
  });

  it("returns insufficient_data when inputs are not durable", () => {
    const decision = evaluateFlip(makeRequest({ provenance: "modelled" }));

    expect(decision.verdict).toBe("insufficient_data");
    expect(decision.belowFloor).toBe(false);
    expect(decision.override).toBeUndefined();
    expect(decision.reasons[0]).toContain("not sourced from durable ledger/projection rows");
  });

  it("allows an explicit override for below-floor pricing and records an audit trail", () => {
    const decision = evaluateFlip(
      makeRequest({
        trainingMarginPerUnitHourCents: 80,
        override: {
          actorId: "user-finance-ops",
          reason: "Strategic capacity build-out for enterprise cohort",
          timestamp: "2026-07-31T05:00:00.000Z",
        },
      }),
    );

    expect(decision.verdict).toBe("justified");
    expect(decision.belowFloor).toBe(true);
    expect(decision.override).toEqual({
      actorId: "user-finance-ops",
      reason: "Strategic capacity build-out for enterprise cohort",
      timestamp: "2026-07-31T05:00:00.000Z",
    });
    expect(decision.reasons[0]).toContain("accepted via explicit override");
  });

  it("works for MIG-slice units as well as whole nodes", () => {
    const decision = evaluateFlip(
      makeRequest({
        unit: { type: "mig_slice", unitId: "mig-7g-001" },
        trainingMarginPerUnitHourCents: 100,
      }),
    );

    expect(decision.verdict).toBe("justified");
    expect(decision.unit.type).toBe("mig_slice");
    expect(decision.unit.unitId).toBe("mig-7g-001");
  });
});
