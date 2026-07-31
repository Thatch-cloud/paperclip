export type TrainingEconomicsProvenance = "measured" | "modelled";

export type TrainingEconomicsWorkloadType = "managed_fine_tune" | "inference" | "spark_training";

export type TrainingEconomicsFlipRecommendation = "train" | "inference" | "hold";

export interface TrainingEconomicsProvenancedValue<T> {
  value: T;
  provenance: TrainingEconomicsProvenance;
}

export interface TrainingEconomicsLaneMargin {
  laneId: string;
  costCents: number;
  revenueCents: number;
  marginCents: number;
  marginPercent: number;
  provenance: TrainingEconomicsProvenance;
}

export interface TrainingEconomicsNodeUtilization {
  nodeConfigId: string;
  nodeId: string;
  utilizationPercent: number;
  provenance: TrainingEconomicsProvenance;
}

export interface TrainingEconomicsTrainVsInference {
  recommendation: TrainingEconomicsFlipRecommendation;
  trainUnitHours: number;
  inferenceUnitHours: number;
  provenance: TrainingEconomicsProvenance;
}

export interface TrainingEconomicsFinancialBenchmark {
  totalCostCents: number;
  excludesSparkTraining: boolean;
  sparkTrainingCostCents: number;
  provenance: TrainingEconomicsProvenance;
}

export interface TrainingEconomicsSummary {
  companyId: string;
  period: {
    start: string;
    end: string;
  };
  summary: {
    unitHours: TrainingEconomicsProvenancedValue<number>;
    totalCostCents: TrainingEconomicsProvenancedValue<number>;
    totalRevenueCents: TrainingEconomicsProvenancedValue<number>;
    marginCents: TrainingEconomicsProvenancedValue<number>;
    marginPercent: TrainingEconomicsProvenancedValue<number>;
  };
  marginsByLane: TrainingEconomicsLaneMargin[];
  nodeUtilization: TrainingEconomicsNodeUtilization[];
  trainVsInference: TrainingEconomicsTrainVsInference;
  financialBenchmark: TrainingEconomicsFinancialBenchmark;
}
