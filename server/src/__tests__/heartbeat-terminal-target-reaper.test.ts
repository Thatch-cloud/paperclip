/**
 * Tests for the terminal-target queued-run reaper (THA-4748).
 *
 * Root-cause: a queued run targeting an issue that flips terminal within the
 * 24ms enqueue-vs-dispatch window can be bypassed by both the enqueue-time
 * check and the dispatch-time gate (evaluateQueuedRunStaleness / claimQueuedRun),
 * because the dispatch-time gate only fires when a run is being dispatched —
 * and runs are deprioritised below higher-ranked runs forever when the target
 * issue is terminal (rank 1 vs rank 0 for in_progress targets).
 *
 * reapTerminalTargetQueuedRuns closes that gap: after 5 min it cancels any
 * queued, never-started run whose contextSnapshot.issueId targets a terminal
 * issue, regardless of invocationSource.
 */

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
import { runningProcesses } from "../adapters/index.ts";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Terminal-target reaper test run.",
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
    `Skipping embedded Postgres terminal-target reaper tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
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
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await db.execute(sql.raw(`
        TRUNCATE TABLE
          "company_skills",
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
      const isLateCommentRace =
        error instanceof Error &&
        error.message.includes("issue_comments_issue_id_issues_id_fk");
      if (!isLateCommentRace || attempt === 9) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

async function seedCompanyAndAgent(db: ReturnType<typeof createDb>) {
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
    name: "TestAgent",
    role: "engineer",
    status: "active",
    adapterType: "codex_local",
    adapterConfig: {},
    runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
    permissions: {},
  });
  return { companyId, agentId };
}

async function seedQueuedRun(
  db: ReturnType<typeof createDb>,
  input: {
    companyId: string;
    agentId: string;
    issueId: string;
    wakeReason: string;
    invocationSource?: "assignment" | "automation";
    backdateMs?: number;
  },
) {
  const wakeupRequestId = randomUUID();
  const runId = randomUUID();
  await db.insert(agentWakeupRequests).values({
    id: wakeupRequestId,
    companyId: input.companyId,
    agentId: input.agentId,
    source: input.invocationSource ?? "assignment",
    triggerDetail: "system",
    reason: input.wakeReason,
    payload: { issueId: input.issueId },
    status: "queued",
  });
  await db.insert(heartbeatRuns).values({
    id: runId,
    companyId: input.companyId,
    agentId: input.agentId,
    invocationSource: input.invocationSource ?? "assignment",
    triggerDetail: "system",
    status: "queued",
    wakeupRequestId,
    contextSnapshot: { issueId: input.issueId, wakeReason: input.wakeReason },
  });
  await db
    .update(agentWakeupRequests)
    .set({ runId })
    .where(eq(agentWakeupRequests.id, wakeupRequestId));

  if (input.backdateMs && input.backdateMs > 0) {
    const past = new Date(Date.now() - input.backdateMs);
    await db
      .update(heartbeatRuns)
      .set({ createdAt: past })
      .where(eq(heartbeatRuns.id, runId));
  }

  return { runId, wakeupRequestId };
}

describeEmbeddedPostgres("reapTerminalTargetQueuedRuns (THA-4748)", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-terminal-target-reaper-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    await ensureIssueRelationsTable(db);
  }, 20_000);

  afterEach(async () => {
    mockAdapterExecute.mockReset();
    runningProcesses.clear();
    for (let i = 0; i < 60; i += 1) {
      const runs = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns);
      if (!runs.some((r) => r.status === "queued" || r.status === "running")) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    await cleanupFixture(db);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("cancels an automation run targeting a done issue when older than the threshold", async () => {
    // Reproduces the 61ae4fa4 scenario: automation wake for an issue that went
    // terminal 24ms after the run was enqueued; the run is deprioritised forever
    // and the dispatch-time gate never fires.
    const { companyId, agentId } = await seedCompanyAndAgent(db);
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Already-done task",
      status: "done",
      priority: "medium",
      assigneeAgentId: agentId,
    });

    const { runId, wakeupRequestId } = await seedQueuedRun(db, {
      companyId,
      agentId,
      issueId,
      wakeReason: "issue_commented",
      invocationSource: "automation",
      backdateMs: 10 * 60 * 1000,
    });

    const result = await heartbeat.reapTerminalTargetQueuedRuns({ thresholdMs: 0 });

    expect(result.reaped).toBe(1);
    expect(result.runIds).toContain(runId);

    const [run, wakeup] = await Promise.all([
      db
        .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode, resultJson: heartbeatRuns.resultJson })
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
    expect((run?.resultJson as Record<string, unknown>)?.timeoutSource).toBe("stale_queued_run_gate");
    expect(wakeup?.status).toBe("skipped");
  });

  it("cancels an assignment run targeting a cancelled issue when older than the threshold", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent(db);
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Cancelled task",
      status: "cancelled",
      priority: "medium",
      assigneeAgentId: agentId,
    });

    const { runId, wakeupRequestId } = await seedQueuedRun(db, {
      companyId,
      agentId,
      issueId,
      wakeReason: "issue_assigned",
      invocationSource: "assignment",
      backdateMs: 10 * 60 * 1000,
    });

    const result = await heartbeat.reapTerminalTargetQueuedRuns({ thresholdMs: 0 });

    expect(result.reaped).toBe(1);
    expect(result.runIds).toContain(runId);

    const run = await db
      .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);

    expect(run?.status).toBe("cancelled");
    expect(run?.errorCode).toBe("issue_terminal_status");
  });

  it("does NOT cancel a run younger than the threshold even if the target issue is done", async () => {
    // Normal dispatch-window row. claimQueuedRun would catch it; this reaper must not.
    const { companyId, agentId } = await seedCompanyAndAgent(db);
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Freshly-done task",
      status: "done",
      priority: "medium",
      assigneeAgentId: agentId,
    });

    const { runId } = await seedQueuedRun(db, {
      companyId,
      agentId,
      issueId,
      wakeReason: "issue_assigned",
      // No backdateMs: run is seconds old; 1-hour threshold means it's "young"
    });

    const result = await heartbeat.reapTerminalTargetQueuedRuns({ thresholdMs: 60 * 60 * 1000 });

    expect(result.reaped).toBe(0);
    expect(result.runIds).not.toContain(runId);

    const run = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);

    expect(run?.status).toBe("queued");
  });

  it("does NOT cancel a run targeting an in_progress issue", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent(db);
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Live task",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
    });

    const { runId } = await seedQueuedRun(db, {
      companyId,
      agentId,
      issueId,
      wakeReason: "issue_assigned",
      backdateMs: 10 * 60 * 1000,
    });

    const result = await heartbeat.reapTerminalTargetQueuedRuns({ thresholdMs: 0 });

    expect(result.reaped).toBe(0);

    const run = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);

    expect(run?.status).toBe("queued");
  });

  it("does NOT cancel a run with no issueId in contextSnapshot", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent(db);
    const wakeupRequestId = randomUUID();
    const runId = randomUUID();

    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "routine_tick",
      payload: {},
      status: "queued",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId,
      contextSnapshot: { wakeReason: "routine_tick" }, // no issueId
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
});
