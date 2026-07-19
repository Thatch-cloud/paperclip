import type { CostByBiller, CostByProviderModel } from "@paperclipai/shared";

type UsageRow = Pick<
  CostByProviderModel,
  | "provider"
  | "biller"
  | "billingType"
  | "model"
  | "costCents"
  | "inputTokens"
  | "cachedInputTokens"
  | "outputTokens"
> &
  Partial<
    Pick<
      CostByProviderModel,
      | "apiRunCount"
      | "subscriptionRunCount"
      | "subscriptionCachedInputTokens"
      | "subscriptionInputTokens"
      | "subscriptionOutputTokens"
    >
  >;

export interface ModelUsageBreakdown {
  provider: string;
  biller: string;
  billingType: CostByProviderModel["billingType"];
  model: string;
  costCents: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  apiRunCount: number;
  subscriptionRunCount: number;
  subscriptionCachedInputTokens: number;
  subscriptionInputTokens: number;
  subscriptionOutputTokens: number;
}

export interface ModelUsageGroup extends ModelUsageBreakdown {
  breakdown: ModelUsageBreakdown[];
}

function addUsage(target: ModelUsageBreakdown, row: UsageRow) {
  target.costCents += row.costCents;
  target.inputTokens += row.inputTokens;
  target.cachedInputTokens += row.cachedInputTokens;
  target.outputTokens += row.outputTokens;
  target.apiRunCount += row.apiRunCount ?? 0;
  target.subscriptionRunCount += row.subscriptionRunCount ?? 0;
  target.subscriptionCachedInputTokens +=
    row.subscriptionCachedInputTokens ?? 0;
  target.subscriptionInputTokens += row.subscriptionInputTokens ?? 0;
  target.subscriptionOutputTokens += row.subscriptionOutputTokens ?? 0;
}

function emptyBreakdown(row: UsageRow): ModelUsageBreakdown {
  return {
    provider: row.provider,
    biller: row.biller,
    billingType: row.billingType,
    model: row.model,
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
}

export function groupUsageByModel(rows: UsageRow[]): ModelUsageGroup[] {
  const groups = new Map<string, ModelUsageGroup>();
  const breakdowns = new Map<string, Map<string, ModelUsageBreakdown>>();

  for (const row of rows) {
    const groupKey = `${row.provider}\u0000${row.model}`;
    const group = groups.get(groupKey) ?? {
      ...emptyBreakdown(row),
      breakdown: [],
    };
    addUsage(group, row);
    groups.set(groupKey, group);

    const detailKey = `${row.provider}\u0000${row.model}\u0000${row.biller}\u0000${row.billingType}`;
    const groupBreakdowns =
      breakdowns.get(groupKey) ?? new Map<string, ModelUsageBreakdown>();
    const detail = groupBreakdowns.get(detailKey) ?? emptyBreakdown(row);
    addUsage(detail, row);
    groupBreakdowns.set(detailKey, detail);
    breakdowns.set(groupKey, groupBreakdowns);
  }

  for (const [groupKey, group] of groups) {
    group.breakdown = Array.from(breakdowns.get(groupKey)?.values() ?? []).sort(
      (a, b) => b.costCents - a.costCents,
    );
  }

  return Array.from(groups.values()).sort((a, b) => b.costCents - a.costCents);
}

export function aggregateBillerUsage(
  rows: CostByProviderModel[],
): CostByBiller[] {
  const map = new Map<string, CostByBiller>();
  const providers = new Map<string, Set<string>>();
  const models = new Map<string, Set<string>>();

  for (const row of rows) {
    const current = map.get(row.biller) ?? {
      biller: row.biller,
      costCents: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      apiRunCount: 0,
      subscriptionRunCount: 0,
      subscriptionCachedInputTokens: 0,
      subscriptionInputTokens: 0,
      subscriptionOutputTokens: 0,
      providerCount: 0,
      modelCount: 0,
    };
    current.costCents += row.costCents;
    current.inputTokens += row.inputTokens;
    current.cachedInputTokens += row.cachedInputTokens;
    current.outputTokens += row.outputTokens;
    current.apiRunCount += row.apiRunCount;
    current.subscriptionRunCount += row.subscriptionRunCount;
    current.subscriptionCachedInputTokens += row.subscriptionCachedInputTokens;
    current.subscriptionInputTokens += row.subscriptionInputTokens;
    current.subscriptionOutputTokens += row.subscriptionOutputTokens;

    const providerSet = providers.get(row.biller) ?? new Set<string>();
    providerSet.add(row.provider);
    providers.set(row.biller, providerSet);

    const modelSet = models.get(row.biller) ?? new Set<string>();
    modelSet.add(row.model);
    models.set(row.biller, modelSet);

    current.providerCount = providerSet.size;
    current.modelCount = modelSet.size;
    map.set(row.biller, current);
  }

  return Array.from(map.values()).sort((a, b) => b.costCents - a.costCents);
}
