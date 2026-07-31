import { describe, expect, it } from "vitest";
import {
  createFineTuneConcurrencyLimiter,
  createFineTuneEntitlementService,
  createFineTuneRateLimiter,
  createInMemoryFineTuneStore,
} from "../services/fine-tune-entitlement.js";
import { HttpError, forbidden } from "../errors.js";

describe("fine-tune entitlement service", () => {
  const now = new Date("2026-07-31T00:00:00.000Z");
  const frozenNow = () => now;
  const residency = { datasetRegion: "ap-southeast-2", adapterRegion: "ap-southeast-2" };

  function makeService(overrides: {
    entitlement?: { enabled: boolean; quotaJobsPerWeek: number; rateLimitRequestsPerMinute: number; concurrencyLimit: number };
    rateLimit?: { maxRequests: number; windowMs: number; now?: () => number };
    concurrencyLimit?: { maxConcurrent: number };
  } = {}) {
    const store = createInMemoryFineTuneStore();
    const entitlement = overrides.entitlement ?? {
      enabled: true,
      quotaJobsPerWeek: 3,
      rateLimitRequestsPerMinute: 5,
      concurrencyLimit: 2,
    };
    store.setEntitlement("company-1", entitlement);

    const rateLimiter = overrides.rateLimit
      ? createFineTuneRateLimiter(overrides.rateLimit)
      : undefined;
    const concurrencyLimiter = overrides.concurrencyLimit
      ? createFineTuneConcurrencyLimiter(overrides.concurrencyLimit)
      : undefined;

    let idCounter = 0;
    const service = createFineTuneEntitlementService({
      store,
      rateLimiter,
      concurrencyLimiter,
      now: frozenNow,
      generateId: () => `job-${++idCounter}`,
      residency,
    });
    return { store, service };
  }

  it("allows a managed fine-tune job for an entitled org", () => {
    const { service } = makeService();
    const job = service.submit("company-1", { datasetId: "dataset-a", baseAdapterId: "adapter-a" });
    expect(job.status).toBe("queued");
    expect(job.residency).toEqual(residency);
  });

  it("rejects submission when managed fine-tuning is not entitled", () => {
    const { store, service } = makeService();
    store.setEntitlement("company-1", { enabled: false, quotaJobsPerWeek: 10, rateLimitRequestsPerMinute: 10, concurrencyLimit: 2 });
    expect(() => service.submit("company-1", { datasetId: "dataset-a", baseAdapterId: "adapter-a" })).toThrow(
      forbidden("Managed fine-tuning is not enabled for this organization"),
    );
  });

  it("rejects submission when no entitlement exists", () => {
    const { store, service } = makeService();
    store.setEntitlement("company-1", undefined as any);
    expect(() => service.submit("company-1", { datasetId: "dataset-a", baseAdapterId: "adapter-a" })).toThrow(
      forbidden("Managed fine-tuning is not enabled for this organization"),
    );
  });

  it("rejects submission that exceeds the weekly quota", () => {
    const { service } = makeService({ entitlement: { enabled: true, quotaJobsPerWeek: 2, rateLimitRequestsPerMinute: 10, concurrencyLimit: 2 } });
    service.submit("company-1", { datasetId: "d1", baseAdapterId: "a1" });
    service.submit("company-1", { datasetId: "d2", baseAdapterId: "a2" });
    expect(() => service.submit("company-1", { datasetId: "d3", baseAdapterId: "a3" })).toThrow(
      new HttpError(429, "Weekly fine-tune quota exceeded", { code: "quota_exceeded" }),
    );
  });

  it("rejects submission that exceeds the per-minute rate limit", () => {
    const rateLimiter = createFineTuneRateLimiter({ maxRequests: 2, windowMs: 60_000, now: () => 0 });
    const { service } = makeService({ rateLimit: { maxRequests: 2, windowMs: 60_000, now: () => 0 } });
    service.submit("company-1", { datasetId: "d1", baseAdapterId: "a1" });
    service.submit("company-1", { datasetId: "d2", baseAdapterId: "a2" });
    expect(() => service.submit("company-1", { datasetId: "d3", baseAdapterId: "a3" })).toThrow(
      new HttpError(429, "Fine-tune request rate limit exceeded", { code: "rate_limited" }),
    );
  });

  it("rejects submission that exceeds the concurrency limit", () => {
    // The service releases the concurrency slot immediately after scheduling. To test the hard
    // denial path we saturate the limiter externally before attempting a submit.
    const store = createInMemoryFineTuneStore();
    store.setEntitlement("company-1", {
      enabled: true,
      quotaJobsPerWeek: 10,
      rateLimitRequestsPerMinute: 10,
      concurrencyLimit: 1,
    });
    const concurrencyLimiter = createFineTuneConcurrencyLimiter({ maxConcurrent: 1 });
    const hold = concurrencyLimiter.acquire("company-1");
    const limitedService = createFineTuneEntitlementService({
      store,
      concurrencyLimiter,
      now: frozenNow,
      generateId: () => crypto.randomUUID(),
      residency,
    });
    expect(() => limitedService.submit("company-1", { datasetId: "d1", baseAdapterId: "a1" })).toThrow(
      new HttpError(429, "Fine-tune concurrency limit exceeded", { code: "concurrency_limited" }),
    );
    hold.release();
  });

  it("rejects submissions containing customer-provided code keywords", () => {
    const { service } = makeService();
    const forbiddenInputs = [
      { datasetId: "dataset-a", baseAdapterId: "adapter-a", script: "print()" },
      { datasetId: "dataset-a", baseAdapterId: "adapter-a", notebook: "train.ipynb" },
      { datasetId: "dataset-a", baseAdapterId: "adapter-a", container: "my-image" },
      { datasetId: "dataset-a", baseAdapterId: "adapter-a", ssh: true },
      { datasetId: "dataset-a", baseAdapterId: "adapter-a", exec: "rm -rf /" },
      { datasetId: "dataset-a", baseAdapterId: "adapter-a", shell: "bash" },
      { datasetId: "dataset-a", baseAdapterId: "adapter-a", python: "train.py" },
      { datasetId: "dataset-a", baseAdapterId: "adapter-a", code: "console.log(1)" },
      { datasetId: "dataset-a", baseAdapterId: "adapter-a", docker: "docker run" },
      { datasetId: "dataset-a", baseAdapterId: "adapter-a", eval: "eval(1+1)" },
    ];
    for (const input of forbiddenInputs) {
      expect(() => service.submit("company-1", input)).toThrow(
        forbidden("Customer-provided code or execution contexts are not allowed for managed fine-tuning"),
      );
    }
  });

  it("retrieves a job by id and company", () => {
    const { service } = makeService();
    const job = service.submit("company-1", { datasetId: "dataset-a", baseAdapterId: "adapter-a" });
    expect(service.getJob("company-1", job.id)).toEqual(job);
    expect(service.getJob("company-2", job.id)).toBeUndefined();
    expect(service.getJob("company-1", "unknown")).toBeUndefined();
  });
});
