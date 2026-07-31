import { useQuery } from "@tanstack/react-query";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";
import { trainingEconomicsApi } from "../api/training-economics";
import { formatCents, formatNumber, cn } from "../lib/utils";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "./EmptyState";
import {
  Activity,
  Cpu,
  DollarSign,
  Scale,
  TrendingUp,
  BrainCircuit,
  AlertCircle,
  FlaskConical,
} from "lucide-react";
import type {
  TrainingEconomicsSummary,
  TrainingEconomicsProvenance,
  TrainingEconomicsFlipRecommendation,
} from "@paperclipai/shared";

function ProvenanceBadge({ provenance, empty }: { provenance: TrainingEconomicsProvenance; empty?: boolean }) {
  if (empty) {
    return (
      <Badge variant="outline" className="ml-2">
        no data
      </Badge>
    );
  }
  return (
    <Badge variant={provenance === "measured" ? "default" : "outline"} className="ml-2">
      {provenance}
    </Badge>
  );
}

function MetricTile({
  label,
  value,
  subtitle,
  icon: Icon,
  provenance,
  empty,
}: {
  label: string;
  value: string;
  subtitle: string;
  icon: React.ComponentType<{ className?: string }>;
  provenance: TrainingEconomicsProvenance;
  empty?: boolean;
}) {
  return (
    <div className="border border-border p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <div className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
              {label}
            </div>
            <ProvenanceBadge provenance={provenance} empty={empty} />
          </div>
          <div className="mt-2 text-2xl font-semibold tabular-nums">{value}</div>
          <div className="mt-1 text-xs leading-5 text-muted-foreground">{subtitle}</div>
        </div>
        <div className="flex h-9 w-9 shrink-0 items-center justify-center border border-border">
          <Icon className="h-4 w-4 text-muted-foreground" />
        </div>
      </div>
    </div>
  );
}

function RecommendationBadge({ recommendation }: { recommendation: TrainingEconomicsFlipRecommendation }) {
  const variant = recommendation === "train" ? "default" : recommendation === "inference" ? "secondary" : "outline";
  const label = recommendation === "train" ? "Flip to train" : recommendation === "inference" ? "Flip to inference" : "Hold";
  return <Badge variant={variant}>{label}</Badge>;
}

function formatPercent(value: number): string {
  return `${value.toFixed(2)}%`;
}

function formatUnitHours(value: number): string {
  return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function SectionLoading() {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-2 xl:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-24 w-full" />
        ))}
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <Skeleton className="h-72 w-full" />
        <Skeleton className="h-72 w-full" />
      </div>
      <Skeleton className="h-48 w-full" />
    </div>
  );
}

export function TrainingEconomicsSection() {
  const { selectedCompanyId } = useCompany();
  const {
    data: summary,
    isLoading,
    error,
  } = useQuery<TrainingEconomicsSummary, Error>({
    queryKey: selectedCompanyId ? queryKeys.trainingEconomics(selectedCompanyId) : ["training-economics", "no-company"],
    queryFn: () => trainingEconomicsApi.summary(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 60_000,
    staleTime: 10_000,
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={BrainCircuit} message="Select a company to view training economics." />;
  }

  if (isLoading) {
    return <SectionLoading />;
  }

  if (error) {
    return (
      <div className="rounded-md border border-destructive/30 bg-destructive/5 p-4">
        <div className="flex items-start gap-3">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          <div className="text-sm text-destructive">
            <p className="font-medium">Training economics unavailable</p>
            <p className="mt-1">{error.message}</p>
          </div>
        </div>
      </div>
    );
  }

  if (!summary) {
    return <EmptyState icon={BrainCircuit} message="No training economics data available." />;
  }

  const summaryEmpty =
    summary.summary.unitHours.value === 0 &&
    summary.summary.totalCostCents.value === 0 &&
    summary.summary.totalRevenueCents.value === 0;

  const marginEmpty = summary.summary.totalRevenueCents.value === 0;

  return (
    <div className="space-y-6" data-testid="training-economics-section">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">Training economics</h2>
          <p className="text-sm text-muted-foreground">
            Last 30 days of managed fine-tune and inference workloads. Spark training is excluded from financial benchmarks.
          </p>
        </div>
        <div className="text-xs text-muted-foreground">
          {new Date(summary.period.start).toLocaleDateString()} – {new Date(summary.period.end).toLocaleDateString()}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <MetricTile
          label="Unit hours"
          value={formatUnitHours(summary.summary.unitHours.value)}
          subtitle="Total training workload hours"
          icon={Activity}
          provenance={summary.summary.unitHours.provenance}
          empty={summaryEmpty}
        />
        <MetricTile
          label="Total cost"
          value={formatCents(summary.summary.totalCostCents.value)}
          subtitle="Cost of non-Spark workloads"
          icon={DollarSign}
          provenance={summary.summary.totalCostCents.provenance}
          empty={summaryEmpty}
        />
        <MetricTile
          label="Total revenue"
          value={formatCents(summary.summary.totalRevenueCents.value)}
          subtitle="Attributed training revenue"
          icon={TrendingUp}
          provenance={summary.summary.totalRevenueCents.provenance}
          empty={summaryEmpty}
        />
        <MetricTile
          label="Margin"
          value={formatCents(summary.summary.marginCents.value)}
          subtitle={marginEmpty ? "No revenue to compare" : `Margin ${formatPercent(summary.summary.marginPercent.value)}`}
          icon={Scale}
          provenance={summary.summary.marginCents.provenance}
          empty={summaryEmpty}
        />
        <MetricTile
          label="Margin %"
          value={formatPercent(summary.summary.marginPercent.value)}
          subtitle={marginEmpty ? "No revenue to compare" : "Revenue minus cost over revenue"}
          icon={Scale}
          provenance={summary.summary.marginPercent.provenance}
          empty={summaryEmpty}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader className="px-5 pt-5 pb-2">
            <CardTitle className="text-base">Margins by lane</CardTitle>
            <CardDescription>
              Cost, revenue, and margin per lane.
              <ProvenanceBadge
                provenance={summary.marginsByLane.length > 0 ? combineProvenance(summary.marginsByLane.map((r) => r.provenance)) : "modelled"}
                empty={summary.marginsByLane.length === 0}
              />
            </CardDescription>
          </CardHeader>
          <CardContent className="px-5 pb-5 pt-2">
            {summary.marginsByLane.length === 0 ? (
              <p className="text-sm text-muted-foreground">No lane data available.</p>
            ) : (
              <div className="space-y-2">
                {summary.marginsByLane.map((row) => (
                  <div
                    key={row.laneId}
                    className="flex items-center justify-between gap-3 border border-border px-3 py-2 text-sm"
                  >
                    <div className="min-w-0">
                      <div className="truncate font-medium">{row.laneId}</div>
                      <div className="text-xs text-muted-foreground">
                        {formatCents(row.costCents)} cost · {formatCents(row.revenueCents)} revenue
                        <ProvenanceBadge provenance={row.provenance} />
                      </div>
                    </div>
                    <div className="text-right tabular-nums">
                      <div className={cn("font-medium", row.marginCents >= 0 ? "text-emerald-600" : "text-red-500")}>
                        {formatCents(row.marginCents)}
                      </div>
                      <div className="text-xs text-muted-foreground">{formatPercent(row.marginPercent)}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="px-5 pt-5 pb-2">
            <CardTitle className="text-base">Node utilization</CardTitle>
            <CardDescription>
              Average utilization per node configuration.
              <ProvenanceBadge
                provenance={summary.nodeUtilization.length > 0 ? combineProvenance(summary.nodeUtilization.map((r) => r.provenance)) : "modelled"}
                empty={summary.nodeUtilization.length === 0}
              />
            </CardDescription>
          </CardHeader>
          <CardContent className="px-5 pb-5 pt-2">
            {summary.nodeUtilization.length === 0 ? (
              <p className="text-sm text-muted-foreground">No node utilization data available.</p>
            ) : (
              <div className="space-y-2">
                {summary.nodeUtilization.map((row) => (
                  <div
                    key={`${row.nodeConfigId}:${row.nodeId}`}
                    className="flex items-center justify-between gap-3 border border-border px-3 py-2 text-sm"
                  >
                    <div className="min-w-0">
                      <div className="truncate font-medium">{row.nodeConfigId}</div>
                      <div className="text-xs text-muted-foreground">
                        {row.nodeId}
                        <ProvenanceBadge provenance={row.provenance} />
                      </div>
                    </div>
                    <div className="text-right tabular-nums">
                      <div className="font-medium">{row.utilizationPercent.toFixed(2)}%</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="px-5 pt-5 pb-2">
            <CardTitle className="text-base">Train vs. inference</CardTitle>
            <CardDescription>
              Workload balance and recommended flip.
              <ProvenanceBadge provenance={summary.trainVsInference.provenance} empty={summary.trainVsInference.trainUnitHours + summary.trainVsInference.inferenceUnitHours === 0} />
            </CardDescription>
          </CardHeader>
          <CardContent className="px-5 pb-5 pt-2 space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="border border-border p-3 text-center">
                <div className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">Train</div>
                <div className="mt-1 text-xl font-semibold tabular-nums">
                  {formatUnitHours(summary.trainVsInference.trainUnitHours)}
                </div>
                <div className="text-xs text-muted-foreground">unit hours</div>
              </div>
              <div className="border border-border p-3 text-center">
                <div className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">Inference</div>
                <div className="mt-1 text-xl font-semibold tabular-nums">
                  {formatUnitHours(summary.trainVsInference.inferenceUnitHours)}
                </div>
                <div className="text-xs text-muted-foreground">unit hours</div>
              </div>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm text-muted-foreground">Recommendation</span>
              <RecommendationBadge recommendation={summary.trainVsInference.recommendation} />
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="px-5 pt-5 pb-2">
          <CardTitle className="text-base">Financial benchmark</CardTitle>
          <CardDescription>
            Managed fine-tune and inference workloads used for the financial benchmark. Spark training is kept separate.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-5 pb-5 pt-2">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <div className="border border-border p-3">
              <div className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">Benchmark cost</div>
              <div className="mt-1 text-xl font-semibold tabular-nums">
                {formatCents(summary.financialBenchmark.totalCostCents)}
              </div>
              <div className="text-xs text-muted-foreground">Managed fine-tune and inference</div>
            </div>
            <div className="border border-border p-3">
              <div className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">Spark training</div>
              <div className="mt-1 text-xl font-semibold tabular-nums">
                {formatCents(summary.financialBenchmark.sparkTrainingCostCents)}
              </div>
              <div className="text-xs text-muted-foreground">Not in benchmark</div>
            </div>
            <div className="border border-border p-3">
              <div className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">Scope</div>
              <div className="mt-1 text-sm font-medium">Managed fine-tune and inference</div>
              <div className="text-xs text-muted-foreground">Guardrails preserved</div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function combineProvenance(provenances: TrainingEconomicsProvenance[]): TrainingEconomicsProvenance {
  if (provenances.length === 0) return "modelled";
  if (provenances.every((p) => p === "measured")) return "measured";
  return "modelled";
}
