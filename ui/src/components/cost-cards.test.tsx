// @vitest-environment node

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CostByBiller, CostByProviderModel } from "@paperclipai/shared";
import { BillerSpendCard } from "./BillerSpendCard";
import { ProviderQuotaCard } from "./ProviderQuotaCard";

const providerRow: CostByProviderModel = {
  provider: "anthropic",
  biller: "liam@agenticintelligence.co.nz",
  billingType: "metered_api",
  model: "claude-sonnet-4-5",
  costCents: 123,
  inputTokens: 1000,
  cachedInputTokens: 200,
  outputTokens: 300,
  apiRunCount: 2,
  subscriptionRunCount: 0,
  subscriptionCachedInputTokens: 0,
  subscriptionInputTokens: 0,
  subscriptionOutputTokens: 0,
};

const billerRow: CostByBiller = {
  biller: "liam@agenticintelligence.co.nz",
  costCents: 123,
  inputTokens: 1000,
  cachedInputTokens: 200,
  outputTokens: 300,
  apiRunCount: 2,
  subscriptionRunCount: 0,
  subscriptionCachedInputTokens: 0,
  subscriptionInputTokens: 0,
  subscriptionOutputTokens: 0,
  providerCount: 1,
  modelCount: 1,
};

describe("cost cards", () => {
  it("renders biller cards with stable account labels instead of raw biller identifiers", () => {
    const html = renderToStaticMarkup(
      <BillerSpendCard
        row={billerRow}
        displayLabel="Account 1"
        weekSpendCents={123}
        budgetMonthlyCents={0}
        totalCompanySpendCents={123}
        providerRows={[providerRow]}
      />,
    );

    expect(html).toContain("Account 1");
    expect(html).not.toContain("liam@agenticintelligence.co.nz");
  });

  it("exposes an explicit model breakdown disclosure affordance", () => {
    const html = renderToStaticMarkup(
      <ProviderQuotaCard
        provider="anthropic"
        rows={[providerRow]}
        budgetMonthlyCents={0}
        totalCompanySpendCents={123}
        weekSpendCents={123}
        windowRows={[]}
        showDeficitNotch={false}
        billerLabels={new Map([[providerRow.biller, "Account 1"]])}
      />,
    );

    expect(html).toContain("Model breakdown");
    expect(html).toContain("aria-expanded=\"false\"");
    expect(html).toContain("claude-sonnet-4-5");
  });
});
