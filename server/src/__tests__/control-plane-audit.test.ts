import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, controlPlaneAuditEvents, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  auditActorFromRequest,
  controlPlaneAuditService,
} from "../services/control-plane-audit.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

describe("auditActorFromRequest", () => {
  it("maps board and agent requests to stable audit actors", () => {
    expect(
      auditActorFromRequest({
        actor: { type: "board", userId: "user-1" },
      } as Express.Request),
    ).toEqual({
      type: "user",
      id: "user-1",
    });
    expect(
      auditActorFromRequest({
        actor: { type: "agent", agentId: "agent-1" },
      } as Express.Request),
    ).toEqual({
      type: "agent",
      id: "agent-1",
    });
    expect(
      auditActorFromRequest({ actor: { type: "none" } } as Express.Request),
    ).toEqual({
      type: "system",
      id: "unauthenticated",
    });
  });
});

describeEmbeddedPostgres("controlPlaneAuditService", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<
    ReturnType<typeof startEmbeddedPostgresTestDatabase>
  > | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase(
      "paperclip-control-plane-audit-",
    );
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(controlPlaneAuditEvents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("records actor, subject, action, source identifiers, outcome, and timestamp", async () => {
    const [company] = await db
      .insert(companies)
      .values({
        name: `Audit ${randomUUID()}`,
        issuePrefix: `AU${randomUUID().slice(0, 6).toUpperCase()}`,
      })
      .returning();

    const event = await controlPlaneAuditService(db).record({
      companyId: company!.id,
      actor: { type: "agent", id: "agent-1" },
      subject: { type: "credential", id: "secret-handle-1" },
      action: "credential.resolve",
      outcome: "denied",
      source: "agent_key",
      requestId: "req-1",
      details: { reason: "scope" },
    });

    expect(event).toMatchObject({
      companyId: company!.id,
      actorType: "agent",
      actorId: "agent-1",
      subjectType: "credential",
      subjectId: "secret-handle-1",
      action: "credential.resolve",
      outcome: "denied",
      source: "agent_key",
      requestId: "req-1",
      details: { reason: "scope" },
    });
    expect(event.createdAt).toBeInstanceOf(Date);
  });
});
