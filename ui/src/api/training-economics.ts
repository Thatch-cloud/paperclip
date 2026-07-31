import type { TrainingEconomicsSummary } from "@paperclipai/shared";
import { api } from "./client";

export const trainingEconomicsApi = {
  summary: (companyId: string) =>
    api.get<TrainingEconomicsSummary>(`/companies/${companyId}/training-economics`),
};
