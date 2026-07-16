import { createHash } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agentApiKeys, agents, companies, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/index.js";
import { dashboardRoutes } from "../routes/dashboard.js";
import { assertCompanyAccess } from "../routes/authz.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres agent API key authz tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

describeEmbeddedPostgres("agent API key scope and expiry authz", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-api-key-authz-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(agentApiKeys);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAgentKey(input: { token: string; scopes: string[] | null; expiresAt: Date | null }) {
    const companyId = "11111111-1111-4111-8111-111111111111";
    const agentId = "22222222-2222-4222-8222-222222222222";

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Probe",
      role: "engineer",
      status: "idle",
      adapterType: "opencode_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(agentApiKeys).values({
      agentId,
      companyId,
      name: "probe",
      keyHash: hashToken(input.token),
      scopes: input.scopes,
      expiresAt: input.expiresAt,
    });

    return { companyId, agentId };
  }

  function createApp() {
    const app = express();
    app.use(express.json());
    app.use(actorMiddleware(db, { deploymentMode: "authenticated" }));
    app.use("/api", dashboardRoutes(db));
    app.patch("/api/companies/:companyId/protected-write", (req, res) => {
      assertCompanyAccess(req, req.params.companyId as string);
      res.json({ ok: true });
    });
    app.use(errorHandler);
    return app;
  }

  it("allows a read-only scoped key to read dashboard data but rejects writes", async () => {
    const token = "pc_read_only_test_key";
    const { companyId } = await seedAgentKey({
      token,
      scopes: ["read"],
      expiresAt: new Date(Date.now() + 60_000),
    });
    const app = createApp();

    await request(app)
      .get(`/api/companies/${companyId}/dashboard`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    const writeRes = await request(app)
      .patch(`/api/companies/${companyId}/protected-write`)
      .set("Authorization", `Bearer ${token}`)
      .send({ ok: true });

    expect(writeRes.status).toBe(403);
    expect(writeRes.body.error).toBe("Agent key scope is read-only");
  });

  it("rejects expired agent API keys before route authorization", async () => {
    const token = "pc_expired_test_key";
    const { companyId } = await seedAgentKey({
      token,
      scopes: ["read"],
      expiresAt: new Date(Date.now() - 60_000),
    });

    const res = await request(createApp())
      .get(`/api/companies/${companyId}/dashboard`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(401);
  });

  it("preserves existing legacy keys with no scope or expiry", async () => {
    const token = "pc_legacy_test_key";
    const { companyId } = await seedAgentKey({ token, scopes: null, expiresAt: null });

    await request(createApp())
      .patch(`/api/companies/${companyId}/protected-write`)
      .set("Authorization", `Bearer ${token}`)
      .send({ ok: true })
      .expect(200);
  });
});
