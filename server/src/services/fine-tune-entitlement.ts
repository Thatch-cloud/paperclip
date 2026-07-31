import { z, ZodError } from "zod";
import { HttpError, forbidden, unprocessable } from "../errors.js";

export type FineTuneJobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export type FineTuneJob = {
  id: string;
  companyId: string;
  datasetId: string;
  baseAdapterId: string;
  requestedAt: Date;
  status: FineTuneJobStatus;
  residency: {
    datasetRegion: string;
    adapterRegion: string;
  };
};

export type FineTuneSubmission = {
  datasetId: string;
  baseAdapterId: string;
};

export type FineTuneEntitlement = {
  enabled: boolean;
  quotaJobsPerWeek: number;
  rateLimitRequestsPerMinute: number;
  concurrencyLimit: number;
};

export type FineTuneStore = {
  getEntitlement(companyId: string): FineTuneEntitlement | undefined;
  setEntitlement(companyId: string, entitlement: FineTuneEntitlement): void;
};

export const fineTuneSubmissionSchema = z.object({
  datasetId: z.string().min(1),
  baseAdapterId: z.string().min(1),
});

export type FineTuneSubmissionInput = z.infer<typeof fineTuneSubmissionSchema>;

export type FineTuneRateLimiter = {
  acquire(companyId: string, now?: number): void;
};

export type FineTuneConcurrencyLimiter = {
  acquire(companyId: string): { release: () => void };
};

export type FineTuneEntitlementService = {
  submit(companyId: string, input: FineTuneSubmissionInput): FineTuneJob;
  getJob(companyId: string, jobId: string): FineTuneJob | undefined;
  createRateLimiter(opts: {
    maxRequests: number;
    windowMs: number;
    now?: () => number;
  }): FineTuneRateLimiter;
  createConcurrencyLimiter(opts: { maxConcurrent: number }): FineTuneConcurrencyLimiter;
};

export function createInMemoryFineTuneStore(): FineTuneStore {
  const store = new Map<string, FineTuneEntitlement>();
  return {
    getEntitlement(companyId) {
      return store.get(companyId);
    },
    setEntitlement(companyId, entitlement) {
      store.set(companyId, entitlement);
    },
  };
}

export function createFineTuneRateLimiter(opts: {
  maxRequests: number;
  windowMs: number;
  now?: () => number;
}): FineTuneRateLimiter {
  const maxRequests = opts.maxRequests;
  const windowMs = opts.windowMs;
  const nowFn = opts.now ?? (() => Date.now());
  const windowsByKey = new Map<string, { startedAt: number; count: number }>();

  return {
    acquire(companyId: string, now?: number) {
      const current = now ?? nowFn();
      for (const [key, existing] of windowsByKey) {
        if (current - existing.startedAt >= windowMs) {
          windowsByKey.delete(key);
        }
      }
      const window = windowsByKey.get(companyId);
      if (!window || current - window.startedAt >= windowMs) {
        windowsByKey.set(companyId, { startedAt: current, count: 1 });
      } else {
        window.count += 1;
        if (window.count > maxRequests) {
          throw new HttpError(429, "Fine-tune request rate limit exceeded", { code: "rate_limited" });
        }
      }
    },
  };
}

export function createFineTuneConcurrencyLimiter(opts: { maxConcurrent: number }): FineTuneConcurrencyLimiter {
  const maxConcurrent = opts.maxConcurrent;
  const activeByKey = new Map<string, number>();

  return {
    acquire(companyId: string) {
      const active = activeByKey.get(companyId) ?? 0;
      if (active >= maxConcurrent) {
        throw new HttpError(429, "Fine-tune concurrency limit exceeded", { code: "concurrency_limited" });
      }
      activeByKey.set(companyId, active + 1);
      return {
        release: () => {
          const current = activeByKey.get(companyId) ?? 0;
          if (current <= 1) activeByKey.delete(companyId);
          else activeByKey.set(companyId, current - 1);
        },
      };
    },
  };
}

function rejectCustomerCode(input: unknown): void {
  const json = JSON.stringify(input);
  const forbiddenPatterns = [
    "code",
    "script",
    "notebook",
    "ssh",
    "container",
    "docker",
    "exec",
    "eval",
    "shell",
    "bash",
    "python",
  ];
  const lower = json.toLowerCase();
  for (const pattern of forbiddenPatterns) {
    if (lower.includes(pattern)) {
      throw forbidden("Customer-provided code or execution contexts are not allowed for managed fine-tuning");
    }
  }
}

export function createFineTuneEntitlementService(opts: {
  store: FineTuneStore;
  rateLimiter?: FineTuneRateLimiter;
  concurrencyLimiter?: FineTuneConcurrencyLimiter;
  /** Injected clock for deterministic tests */
  now?: () => Date;
  generateId?: () => string;
  residency?: {
    datasetRegion: string;
    adapterRegion: string;
  };
}): FineTuneEntitlementService {
  const store = opts.store;
  const rateLimiter = opts.rateLimiter;
  const concurrencyLimiter = opts.concurrencyLimiter;
  const now = opts.now ?? (() => new Date());
  const generateId = opts.generateId ?? (() => crypto.randomUUID());
  const residency = opts.residency ?? { datasetRegion: "ap-southeast-2", adapterRegion: "ap-southeast-2" };
  const jobs = new Map<string, FineTuneJob>();
  const jobsByCompany = new Map<string, FineTuneJob[]>();

  function recordJob(job: FineTuneJob) {
    jobs.set(job.id, job);
    const companyJobs = jobsByCompany.get(job.companyId) ?? [];
    companyJobs.push(job);
    jobsByCompany.set(job.companyId, companyJobs);
  }

  function countJobsThisWeek(entitlement: FineTuneEntitlement, companyId: string): number {
    const weekMs = 7 * 24 * 60 * 60 * 1000;
    const current = now().getTime();
    const companyJobs = jobsByCompany.get(companyId) ?? [];
    return companyJobs.filter((job) => current - job.requestedAt.getTime() < weekMs).length;
  }

  return {
    submit(companyId, rawInput) {
      let input: FineTuneSubmissionInput;
      try {
        input = fineTuneSubmissionSchema.parse(rawInput);
      } catch (error) {
        if (error instanceof ZodError) {
          throw unprocessable(error.errors.map((e) => e.message).join("; "));
        }
        throw error;
      }

      rejectCustomerCode(rawInput);

      const entitlement = store.getEntitlement(companyId);
      if (!entitlement || !entitlement.enabled) {
        throw forbidden("Managed fine-tuning is not enabled for this organization");
      }

      rateLimiter?.acquire(companyId);

      const concurrencySlot = concurrencyLimiter?.acquire(companyId);
      try {
        const jobsThisWeek = countJobsThisWeek(entitlement, companyId);
        if (jobsThisWeek >= entitlement.quotaJobsPerWeek) {
          throw new HttpError(429, "Weekly fine-tune quota exceeded", { code: "quota_exceeded" });
        }

        const job: FineTuneJob = {
          id: generateId(),
          companyId,
          datasetId: input.datasetId,
          baseAdapterId: input.baseAdapterId,
          requestedAt: now(),
          status: "queued",
          residency: {
            datasetRegion: residency.datasetRegion,
            adapterRegion: residency.adapterRegion,
          },
        };
        recordJob(job);
        return job;
      } finally {
        // Release the concurrency slot immediately after scheduling; the job is queued, not running.
        concurrencySlot?.release();
      }
    },
    getJob(companyId, jobId) {
      const job = jobs.get(jobId);
      if (job && job.companyId !== companyId) return undefined;
      return job;
    },
    createRateLimiter(opts) {
      return createFineTuneRateLimiter(opts);
    },
    createConcurrencyLimiter(opts) {
      return createFineTuneConcurrencyLimiter(opts);
    },
  };
}
