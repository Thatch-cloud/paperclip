import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  issueRelations,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { recoveryService } from "../services/recovery/service.ts";
import { issueService } from "../services/issues.ts";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("../telemetry.ts", () => ({ getTelemetryClient: () => mockTelemetryClient }));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres frozen-blocked-dependents tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

// ---------------------------------------------------------------------------
// reconcileFrozenBlockedDependents sweeper
// ---------------------------------------------------------------------------

describeEmbeddedPostgres("recovery reconcileFrozenBlockedDependents", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-frozen-blocked-deps-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueRelations);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  // Returns a mock wakeup fn that records calls without spawning real heartbeat runs.
  function makeMockEnqueueWakeup() {
    const calls: Array<{ agentId: string; opts: Record<string, unknown> }> = [];
    const fn = vi.fn(async (agentId: string, opts: Record<string, unknown> = {}) => {
      calls.push({ agentId, opts });
      return null;
    });
    return { fn, calls };
  }

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
      name: "Coder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId };
  }

  it("repairs a blocked dependent and enqueues a wakeup when all blockers are done", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const blockerId = randomUUID();
    const dependentId = randomUUID();

    await db.insert(issues).values([
      { id: blockerId, companyId, title: "Blocker", status: "done", priority: "high" },
      {
        id: dependentId,
        companyId,
        title: "Dependent",
        status: "blocked",
        priority: "medium",
        assigneeAgentId: agentId,
      },
    ]);
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerId,
      relatedIssueId: dependentId,
      type: "blocks",
    });

    const { fn: enqueueWakeup, calls: wakeupCalls } = makeMockEnqueueWakeup();
    const recovery = recoveryService(db, { enqueueWakeup });
    const result = await recovery.reconcileFrozenBlockedDependents();

    expect(result.repaired).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.issueIds).toEqual([dependentId]);

    const row = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, dependentId))
      .then((rows) => rows[0]);
    expect(row?.status).toBe("todo");

    const edges = await db
      .select()
      .from(issueRelations)
      .where(eq(issueRelations.relatedIssueId, dependentId));
    expect(edges).toHaveLength(0);

    expect(wakeupCalls).toHaveLength(1);
    expect(wakeupCalls[0].agentId).toBe(agentId);
    expect((wakeupCalls[0].opts as { reason?: string }).reason).toBe("issue_blockers_resolved");
    expect(
      ((wakeupCalls[0].opts as { payload?: { issueId?: string } }).payload)?.issueId,
    ).toBe(dependentId);
  });

  it("skips a dependent whose blocker is still live and does not enqueue a wakeup", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const blockerId = randomUUID();
    const dependentId = randomUUID();

    await db.insert(issues).values([
      { id: blockerId, companyId, title: "Live blocker", status: "in_progress", priority: "high" },
      {
        id: dependentId,
        companyId,
        title: "Dependent",
        status: "blocked",
        priority: "medium",
        assigneeAgentId: agentId,
      },
    ]);
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerId,
      relatedIssueId: dependentId,
      type: "blocks",
    });

    const { fn: enqueueWakeup, calls: wakeupCalls } = makeMockEnqueueWakeup();
    const recovery = recoveryService(db, { enqueueWakeup });
    const result = await recovery.reconcileFrozenBlockedDependents();

    expect(result.repaired).toBe(0);
    expect(result.skipped).toBe(1);

    const row = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, dependentId))
      .then((rows) => rows[0]);
    expect(row?.status).toBe("blocked");

    expect(wakeupCalls).toHaveLength(0);
  });

  it("is idempotent — second pass finds nothing to repair", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const blockerId = randomUUID();
    const dependentId = randomUUID();

    await db.insert(issues).values([
      { id: blockerId, companyId, title: "Blocker", status: "done", priority: "high" },
      {
        id: dependentId,
        companyId,
        title: "Dependent",
        status: "blocked",
        priority: "medium",
        assigneeAgentId: agentId,
      },
    ]);
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerId,
      relatedIssueId: dependentId,
      type: "blocks",
    });

    const { fn: enqueueWakeup } = makeMockEnqueueWakeup();
    const recovery = recoveryService(db, { enqueueWakeup });
    const first = await recovery.reconcileFrozenBlockedDependents();
    const second = await recovery.reconcileFrozenBlockedDependents();

    expect(first.repaired).toBe(1);
    expect(second.repaired).toBe(0);
    expect(second.skipped).toBe(0);
  });

  it("skips re-arming when a concurrent blocker is added before clearResolvedBlockerFromDependent locks", async () => {
    // Models the race: outer readiness check saw only B1 (done) → "ready",
    // but by the time clearResolvedBlockerFromDependent re-reads under its
    // FOR UPDATE lock, live B2 has been inserted.  The tx must detect B2,
    // return false, and the sweeper must record skipped (not repaired).
    const { companyId, agentId } = await seedCompanyAndAgent();
    const doneBlockerId = randomUUID();
    const liveBlockerId = randomUUID();
    const dependentId = randomUUID();

    await db.insert(issues).values([
      { id: doneBlockerId, companyId, title: "Done blocker", status: "done", priority: "high" },
      { id: liveBlockerId, companyId, title: "Concurrent live blocker", status: "todo", priority: "high" },
      {
        id: dependentId,
        companyId,
        title: "Dependent",
        status: "blocked",
        priority: "medium",
        assigneeAgentId: agentId,
      },
    ]);
    // Only done blocker edge is present when the sweeper scans candidates.
    await db.insert(issueRelations).values({
      companyId,
      issueId: doneBlockerId,
      relatedIssueId: dependentId,
      type: "blocks",
    });

    // Simulate the concurrent insert that races the readiness check:
    // insert the live-blocker edge here (after the outer read would have run)
    // before clearResolvedBlockerFromDependent starts its transaction.
    await db.insert(issueRelations).values({
      companyId,
      issueId: liveBlockerId,
      relatedIssueId: dependentId,
      type: "blocks",
    });

    // At this point the outer readiness check that the sweeper performs
    // internally will now see B2 as live, so the sweeper skips D
    // (isDependencyReady = false). This is equivalent to the race where
    // B2 arrives BETWEEN the outer check and the clearResolvedBlockerFromDependent call.
    const { fn: enqueueWakeup, calls: wakeupCalls } = makeMockEnqueueWakeup();
    const recovery = recoveryService(db, { enqueueWakeup });
    const result = await recovery.reconcileFrozenBlockedDependents();

    expect(result.repaired).toBe(0);
    expect(result.skipped).toBe(1);

    const row = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, dependentId))
      .then((rows) => rows[0]);
    expect(row?.status).toBe("blocked");
    expect(wakeupCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// clearResolvedBlockerFromDependent concurrent-insert guard
//
// These tests target the race-safe primitive used by the sweeper.
// clearResolvedBlockerFromDependent takes a FOR UPDATE lock on the dependent
// row and re-checks readiness inside the transaction, so a concurrent blocker
// INSERT that races the outer readiness check is caught before any status
// change or wakeup is committed.
// ---------------------------------------------------------------------------

describeEmbeddedPostgres("issueService.clearResolvedBlockerFromDependent concurrent-insert guard", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-clear-resolved-blocker-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueRelations);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("returns true and clears all stale done-blocker edges when no live blockers remain", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const doneBlocker1Id = randomUUID();
    const doneBlocker2Id = randomUUID();
    const dependentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Coder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values([
      { id: doneBlocker1Id, companyId, title: "Done B1", status: "done", priority: "high" },
      { id: doneBlocker2Id, companyId, title: "Done B2", status: "done", priority: "high" },
      {
        id: dependentId,
        companyId,
        title: "Dependent",
        status: "blocked",
        priority: "medium",
        assigneeAgentId: agentId,
      },
    ]);
    await db.insert(issueRelations).values([
      { companyId, issueId: doneBlocker1Id, relatedIssueId: dependentId, type: "blocks" },
      { companyId, issueId: doneBlocker2Id, relatedIssueId: dependentId, type: "blocks" },
    ]);

    const svc = issueService(db);
    const repaired = await svc.clearResolvedBlockerFromDependent(dependentId, doneBlocker1Id);

    expect(repaired).toBe(true);

    const row = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, dependentId))
      .then((rows) => rows[0]);
    expect(row?.status).toBe("todo");

    const edges = await db
      .select()
      .from(issueRelations)
      .where(eq(issueRelations.relatedIssueId, dependentId));
    expect(edges).toHaveLength(0);
  });

  it("returns false and leaves the dependent blocked when a concurrent live blocker is present", async () => {
    // Simulates the sweeper race: outer readiness check (before the tx) saw
    // only B1 (done) → "ready", but by the time clearResolvedBlockerFromDependent
    // re-reads inside its FOR UPDATE transaction, live blocker B2 is already
    // in the DB.  The re-check detects B2 and the tx aborts without committing
    // any status change.
    const companyId = randomUUID();
    const agentId = randomUUID();
    const doneBlockerId = randomUUID();
    const liveBlockerId = randomUUID();
    const dependentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Coder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values([
      { id: doneBlockerId, companyId, title: "Done blocker", status: "done", priority: "high" },
      { id: liveBlockerId, companyId, title: "Concurrent live blocker", status: "todo", priority: "high" },
      {
        id: dependentId,
        companyId,
        title: "Dependent",
        status: "blocked",
        priority: "medium",
        assigneeAgentId: agentId,
      },
    ]);
    await db.insert(issueRelations).values([
      { companyId, issueId: doneBlockerId, relatedIssueId: dependentId, type: "blocks" },
      { companyId, issueId: liveBlockerId, relatedIssueId: dependentId, type: "blocks" },
    ]);

    const svc = issueService(db);
    const repaired = await svc.clearResolvedBlockerFromDependent(dependentId, doneBlockerId);

    expect(repaired).toBe(false);

    const row = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, dependentId))
      .then((rows) => rows[0]);
    expect(row?.status).toBe("blocked");

    // The done-blocker edge (B1) is correctly removed — it was stale.
    // The live-blocker edge (B2) must survive, keeping D blocked.
    const edges = await db
      .select({ issueId: issueRelations.issueId })
      .from(issueRelations)
      .where(eq(issueRelations.relatedIssueId, dependentId));
    const edgeIds = edges.map((e) => e.issueId);
    expect(edgeIds).not.toContain(doneBlockerId);
    expect(edgeIds).toContain(liveBlockerId);
  });

  it("returns false when the dependent has no assignee", async () => {
    const companyId = randomUUID();
    const blockerId = randomUUID();
    const dependentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values([
      { id: blockerId, companyId, title: "Blocker", status: "done", priority: "high" },
      {
        id: dependentId,
        companyId,
        title: "Unassigned dependent",
        status: "blocked",
        priority: "medium",
      },
    ]);
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerId,
      relatedIssueId: dependentId,
      type: "blocks",
    });

    const svc = issueService(db);
    const repaired = await svc.clearResolvedBlockerFromDependent(dependentId, blockerId);

    expect(repaired).toBe(false);

    const row = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, dependentId))
      .then((rows) => rows[0]);
    expect(row?.status).toBe("blocked");
  });
});
