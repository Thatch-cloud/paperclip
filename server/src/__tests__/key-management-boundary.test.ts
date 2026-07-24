import { randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { activityLog, agentApiKeys, agents, companies, createDb } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.js";
import { companyService } from "../services/companies.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping key management boundary tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("key management DB boundary", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<
    ReturnType<typeof startEmbeddedPostgresTestDatabase>
  > | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase(
      "paperclip-key-management-boundary-",
    );
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(agentApiKeys);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function keyManagementDbSpy() {
    const calls = {
      delete: vi.fn((...args: Parameters<typeof db.delete>) =>
        db.delete(...args),
      ),
      insert: vi.fn((...args: Parameters<typeof db.insert>) =>
        db.insert(...args),
      ),
      update: vi.fn((...args: Parameters<typeof db.update>) =>
        db.update(...args),
      ),
    };
    const proxy = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "delete") return calls.delete;
        if (prop === "insert") return calls.insert;
        if (prop === "update") return calls.update;
        return Reflect.get(target, prop, receiver);
      },
    });
    return { calls, db: proxy };
  }

  async function seedAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Key Boundary Co",
      issuePrefix: `K${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Key Boundary Agent",
      role: "engineer",
      status: "idle",
      adapterType: "opencode_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { agentId, companyId };
  }

  it("routes agent key lifecycle writes through the key management DB", async () => {
    const { agentId } = await seedAgent();
    const keyManagement = keyManagementDbSpy();
    const svc = agentService(db, { keyManagementDb: keyManagement.db });

    const created = await svc.createApiKey(
      agentId,
      { name: "agent test key", scopes: ["read"], expiresAt: new Date(Date.now() + 60_000).toISOString() },
      { actorType: "user", actorId: "board" },
    );
    await svc.revokeKey(agentId, created.id);
    await svc.terminate(agentId);

    expect(keyManagement.calls.insert).toHaveBeenCalledWith(agentApiKeys);
    expect(keyManagement.calls.update).toHaveBeenCalledWith(agentApiKeys);
  });

  it("always writes an agent.key_created audit row regardless of which db handles key writes", async () => {
    const { agentId } = await seedAgent();
    const keyManagement = keyManagementDbSpy();
    // Use a separate key db so the route through keyManagementDb is exercised;
    // activityDb defaults to the main db, which is what we query.
    const svc = agentService(db, { keyManagementDb: keyManagement.db });

    await svc.createApiKey(
      agentId,
      { name: "audited key", scopes: ["write"], expiresAt: new Date(Date.now() + 60_000).toISOString() },
      { actorType: "system", actorId: "test-runner" },
    );

    const rows = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "agent.key_created"));

    expect(rows).toHaveLength(1);
    expect(rows[0].actorType).toBe("system");
    expect(rows[0].actorId).toBe("test-runner");
    expect(rows[0].entityId).toBe(agentId);
  });

  it("routes destructive agent and company key cleanup through the key management DB", async () => {
    const { agentId } = await seedAgent();
    const agentKeyManagement = keyManagementDbSpy();

    await agentService(db, { keyManagementDb: agentKeyManagement.db }).remove(
      agentId,
    );
    expect(agentKeyManagement.calls.delete).toHaveBeenCalledWith(agentApiKeys);

    const { companyId: removalCompanyId } = await seedAgent();
    const companyKeyManagement = keyManagementDbSpy();

    await companyService(db, {
      keyManagementDb: companyKeyManagement.db,
    }).remove(removalCompanyId);
    expect(companyKeyManagement.calls.delete).toHaveBeenCalledWith(
      agentApiKeys,
    );
  });
});
