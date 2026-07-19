import { describe, expect, it } from "vitest";
import type { CostByProviderModel } from "@paperclipai/shared";
import { aggregateBillerUsage, groupUsageByModel } from "./costUsageGrouping";

const baseRow: CostByProviderModel = {
  provider: "anthropic",
  biller: "anthropic",
  billingType: "metered_api",
  model: "claude-sonnet-4-5",
  costCents: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  apiRunCount: 0,
  subscriptionRunCount: 0,
  subscriptionCachedInputTokens: 0,
  subscriptionInputTokens: 0,
  subscriptionOutputTokens: 0,
};

describe("cost usage grouping", () => {
  it("rolls duplicate provider model rows into one top-level model with detail rows", () => {
    const rows: CostByProviderModel[] = [
      {
        ...baseRow,
        costCents: 120,
        inputTokens: 1000,
        outputTokens: 100,
        apiRunCount: 1,
      },
      {
        ...baseRow,
        costCents: 80,
        cachedInputTokens: 600,
        outputTokens: 50,
        apiRunCount: 2,
      },
      {
        ...baseRow,
        billingType: "subscription_included",
        costCents: 0,
        subscriptionRunCount: 3,
        subscriptionInputTokens: 900,
      },
    ];

    const grouped = groupUsageByModel(rows);

    expect(grouped).toHaveLength(1);
    expect(grouped[0]).toMatchObject({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      costCents: 200,
      inputTokens: 1000,
      cachedInputTokens: 600,
      outputTokens: 150,
      apiRunCount: 3,
      subscriptionRunCount: 3,
    });
    expect(grouped[0].breakdown).toHaveLength(2);
    expect(grouped[0].breakdown.map((row) => row.billingType)).toEqual([
      "metered_api",
      "subscription_included",
    ]);
  });

  it("builds billing rows from provider usage when billing data is absent", () => {
    const rows: CostByProviderModel[] = [
      {
        ...baseRow,
        biller: "anthropic",
        costCents: 120,
        inputTokens: 1000,
        outputTokens: 100,
        apiRunCount: 1,
      },
      {
        ...baseRow,
        biller: "anthropic",
        provider: "openrouter",
        costCents: 80,
        model: "claude-sonnet-4-5",
        cachedInputTokens: 600,
        outputTokens: 50,
        apiRunCount: 2,
      },
      {
        ...baseRow,
        biller: "openai",
        provider: "openai",
        model: "gpt-5",
        costCents: 40,
        outputTokens: 25,
        subscriptionRunCount: 1,
      },
    ];

    const billers = aggregateBillerUsage(rows);

    expect(billers.map((row) => row.biller)).toEqual(["anthropic", "openai"]);
    expect(billers[0]).toMatchObject({
      biller: "anthropic",
      costCents: 200,
      providerCount: 2,
      modelCount: 1,
      apiRunCount: 3,
    });
    expect(billers[1]).toMatchObject({
      biller: "openai",
      costCents: 40,
      providerCount: 1,
      modelCount: 1,
      subscriptionRunCount: 1,
    });
  });
});
