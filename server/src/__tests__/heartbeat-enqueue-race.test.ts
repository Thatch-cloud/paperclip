import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { issueService } from "../services/issues.ts";
import { runningProcesses } from "../adapters/index.ts";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Enqueue-race test run.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat enqueue-race tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function ensureIssueRelationsTable(db: ReturnType<typeof createDb>) {
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS "issue_relations" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "company_id" uuid NOT NULL,
      "issue_id" uuid NOT NULL,
      "related_issue_id" uuid NOT NULL,
      "type" text NOT NULL,
      "created_by_agent_id" uuid,
      "created_by_user_id" text,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "updated_at" timestamptz NOT NULL DEFAULT now()
    );
  `));
}

async function cleanupFixture(db: ReturnType<typeof createDb>) {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      await db.execute(sql.raw(`
        TRUNCATE TABLE
          "company_skills",
          "issue_thread_interactions",
          "issue_comments",
          "issue_documents",
          "document_revisions",
          "documents",
          "issue_relations",
          "issue_tree_holds",
          "issues",
          "heartbeat_run_events",
          "activity_log",
          "heartbeat_runs",
          "agent_wakeup_requests",
          "agent_runtime_state",
          "agents",
          "companies"
        RESTART IDENTITY CASCADE
      `));
      return;
    } catch (error) {
      if (attempt === 9) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

describeEmbeddedPostgres("heartbeat enqueue-vs-dispatch race fixes", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-enqueue-race-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    await ensureIssueRelationsTable(db);
  }, 20_000);

  afterEach(async () => {
    mockAdapterExecute.mockReset();
    runningProcesses.clear();
    for (let i = 0; i < 60; i++) {
      const runs = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns);
      if (!runs.some((r) => r.status === "queued" || r.status === "running")) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await cleanupFixture(db);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "TestCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function seedQueuedRunForIssue(input: { companyId: string; agentId: string; issueId: string }) {
    const wakeupRequestId = randomUUID();
    const runId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId: input.companyId,
      agentId: input.agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId: input.issueId },
      status: "queued",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId,
      contextSnapshot: { issueId: input.issueId, wakeReason: "issue_assigned" },
    });
    await db
      .update(agentWakeupRequests)
      .set({ runId })
      .where(eq(agentWakeupRequests.id, wakeupRequestId));
    return { runId, wakeupRequestId };
  }

  async function seedQueuedRunWithoutIssue(input: { companyId: string; agentId: string }) {
    const wakeupRequestId = randomUUID();
    const runId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId: input.companyId,
      agentId: input.agentId,
      source: "on_demand",
      triggerDetail: "system",
      reason: "manual",
      payload: {},
      status: "queued",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "on_demand",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId,
      contextSnapshot: {},
    });
    await db
      .update(agentWakeupRequests)
      .set({ runId })
      .where(eq(agentWakeupRequests.id, wakeupRequestId));
    return { runId, wakeupRequestId };
  }

  it("cancels queued runs inside the issue-close transaction (cancel-at-close race fix)", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Task to be closed",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
    });

    const { runId, wakeupRequestId } = await seedQueuedRunForIssue({ companyId, agentId, issueId });

    const beforeClose = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    expect(beforeClose?.status).toBe("queued");

    // Closing the issue triggers cancelQueuedRunsForTerminalIssue inside the same transaction.
    // The run must be cancelled without resumeQueuedRuns being called.
    const svc = issueService(db);
    await svc.update(issueId, { status: "done" });

    const [run, wakeup] = await Promise.all([
      db
        .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null),
      db
        .select({ status: agentWakeupRequests.status })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, wakeupRequestId))
        .then((rows) => rows[0] ?? null),
    ]);

    expect(run?.status).toBe("cancelled");
    expect(run?.errorCode).toBe("issue_terminal_status");
    expect(wakeup?.status).toBe("skipped");
  });

  it("reapTerminalTargetQueuedRuns cancels queued runs whose target issue is already terminal", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Already done task",
      status: "done",
      priority: "medium",
    });

    const { runId, wakeupRequestId } = await seedQueuedRunForIssue({ companyId, agentId, issueId });

    // Simulate the run having been queued longer than the reap threshold
    await db
      .update(heartbeatRuns)
      .set({ createdAt: new Date(Date.now() - 10 * 60 * 1000) })
      .where(eq(heartbeatRuns.id, runId));

    const result = await heartbeat.reapTerminalTargetQueuedRuns({ thresholdMs: 0 });

    expect(result.reaped).toBe(1);
    expect(result.runIds).toContain(runId);

    const [run, wakeup] = await Promise.all([
      db
        .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null),
      db
        .select({ status: agentWakeupRequests.status })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, wakeupRequestId))
        .then((rows) => rows[0] ?? null),
    ]);

    expect(run?.status).toBe("cancelled");
    expect(run?.errorCode).toBe("issue_terminal_status");
    expect(wakeup?.status).toBe("skipped");
  });

  it("reapTerminalTargetQueuedRuns does not reap runs whose target issue is still active", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "In-progress task",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
    });

    const { runId } = await seedQueuedRunForIssue({ companyId, agentId, issueId });

    await db
      .update(heartbeatRuns)
      .set({ createdAt: new Date(Date.now() - 10 * 60 * 1000) })
      .where(eq(heartbeatRuns.id, runId));

    const result = await heartbeat.reapTerminalTargetQueuedRuns({ thresholdMs: 0 });

    expect(result.reaped).toBe(0);

    const run = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);

    expect(run?.status).toBe("queued");
  });

  it("reapOrphanedQueuedRuns cancels queued runs with no issueId past TTL", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();

    const { runId, wakeupRequestId } = await seedQueuedRunWithoutIssue({ companyId, agentId });

    await db
      .update(heartbeatRuns)
      .set({ createdAt: new Date(Date.now() - 90 * 60 * 1000) })
      .where(eq(heartbeatRuns.id, runId));

    const result = await heartbeat.reapOrphanedQueuedRuns({ thresholdMs: 0 });

    expect(result.reaped).toBe(1);
    expect(result.runIds).toContain(runId);

    const [run, wakeup] = await Promise.all([
      db
        .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null),
      db
        .select({ status: agentWakeupRequests.status })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, wakeupRequestId))
        .then((rows) => rows[0] ?? null),
    ]);

    expect(run?.status).toBe("cancelled");
    expect(run?.errorCode).toBe("stale_queued_no_target");
    expect(wakeup?.status).toBe("skipped");
  });

  it("cancel-at-close does not cancel queued runs on a re-PATCH of an already-terminal issue", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();

    // Issue starts done (already terminal)
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Already done task",
      status: "done",
      priority: "medium",
      assigneeAgentId: agentId,
    });

    // Queue a run — simulates a resumeIntent / comment wake that arrived after close
    const { runId } = await seedQueuedRunForIssue({ companyId, agentId, issueId });

    // Re-PATCH status: "done" on an already-done issue (no-op transition)
    const svc = issueService(db);
    await svc.update(issueId, { status: "done" });

    // The queued run must NOT have been cancelled by cancel-at-close
    const run = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);

    expect(run?.status).toBe("queued");
  });

  it("reapTerminalTargetQueuedRuns does not reap runs with resumeIntent on a terminal issue", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Done task with a resume wake",
      status: "done",
      priority: "medium",
    });

    const wakeupRequestId = randomUUID();
    const runId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "on_demand",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: { issueId },
      status: "queued",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId,
      contextSnapshot: { issueId, resumeIntent: true },
    });
    await db
      .update(agentWakeupRequests)
      .set({ runId })
      .where(eq(agentWakeupRequests.id, wakeupRequestId));

    await db
      .update(heartbeatRuns)
      .set({ createdAt: new Date(Date.now() - 10 * 60 * 1000) })
      .where(eq(heartbeatRuns.id, runId));

    const result = await heartbeat.reapTerminalTargetQueuedRuns({ thresholdMs: 0 });

    expect(result.reaped).toBe(0);

    const run = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);

    expect(run?.status).toBe("queued");
  });

  it("reapTerminalTargetQueuedRuns does not reap runs with wakeCommentId on a terminal issue", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    const commentId = randomUUID();

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Cancelled task with a comment wake",
      status: "cancelled",
      priority: "medium",
    });

    const wakeupRequestId = randomUUID();
    const runId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "on_demand",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: { issueId },
      status: "queued",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId,
      contextSnapshot: { issueId, wakeCommentId: commentId },
    });
    await db
      .update(agentWakeupRequests)
      .set({ runId })
      .where(eq(agentWakeupRequests.id, wakeupRequestId));

    await db
      .update(heartbeatRuns)
      .set({ createdAt: new Date(Date.now() - 10 * 60 * 1000) })
      .where(eq(heartbeatRuns.id, runId));

    const result = await heartbeat.reapTerminalTargetQueuedRuns({ thresholdMs: 0 });

    expect(result.reaped).toBe(0);

    const run = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);

    expect(run?.status).toBe("queued");
  });

  it("reapOrphanedQueuedRuns does not reap queued runs that have an issueId", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Active task with a run",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
    });

    const { runId } = await seedQueuedRunForIssue({ companyId, agentId, issueId });

    await db
      .update(heartbeatRuns)
      .set({ createdAt: new Date(Date.now() - 90 * 60 * 1000) })
      .where(eq(heartbeatRuns.id, runId));

    const result = await heartbeat.reapOrphanedQueuedRuns({ thresholdMs: 0 });

    expect(result.reaped).toBe(0);

    const run = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);

    expect(run?.status).toBe("queued");
  });
});
