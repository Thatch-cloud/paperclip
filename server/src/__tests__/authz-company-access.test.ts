import { describe, expect, it } from "vitest";
import {
  assertBoardOrgAccess,
  assertCompanyAccess,
  assertControlPlaneSurfaceAccess,
  hasBoardOrgAccess,
} from "../routes/authz.js";

function makeReq(input: { method?: string; actor: Express.Request["actor"] }) {
  return {
    method: input.method ?? "GET",
    actor: input.actor,
  } as Express.Request;
}

describe("assertCompanyAccess", () => {
  it("allows viewer memberships to read", () => {
    const req = makeReq({
      method: "GET",
      actor: {
        type: "board",
        userId: "user-1",
        source: "session",
        companyIds: ["company-1"],
        memberships: [
          {
            companyId: "company-1",
            membershipRole: "viewer",
            status: "active",
          },
        ],
      },
    });

    expect(() => assertCompanyAccess(req, "company-1")).not.toThrow();
  });

  it("rejects viewer memberships for writes", () => {
    const req = makeReq({
      method: "PATCH",
      actor: {
        type: "board",
        userId: "user-1",
        source: "session",
        companyIds: ["company-1"],
        memberships: [
          {
            companyId: "company-1",
            membershipRole: "viewer",
            status: "active",
          },
        ],
      },
    });

    expect(() => assertCompanyAccess(req, "company-1")).toThrow(
      "Viewer access is read-only",
    );
  });

  it("rejects writes when membership details are present but omit the target company", () => {
    const req = makeReq({
      method: "POST",
      actor: {
        type: "board",
        userId: "user-1",
        source: "session",
        companyIds: ["company-1"],
        memberships: [],
      },
    });

    expect(() => assertCompanyAccess(req, "company-1")).toThrow(
      "User does not have active company access",
    );
  });

  it("allows legacy board actors that only provide company ids", () => {
    const req = makeReq({
      method: "POST",
      actor: {
        type: "board",
        userId: "user-1",
        source: "session",
        companyIds: ["company-1"],
      },
    });

    expect(() => assertCompanyAccess(req, "company-1")).not.toThrow();
  });

  it("allows read-only scoped agent keys to read", () => {
    const req = makeReq({
      method: "GET",
      actor: {
        type: "agent",
        agentId: "agent-1",
        companyId: "company-1",
        keyScopes: ["read"],
        source: "agent_key",
      },
    });

    expect(() => assertCompanyAccess(req, "company-1")).not.toThrow();
  });

  it("rejects read-only scoped agent keys for writes", () => {
    const req = makeReq({
      method: "PATCH",
      actor: {
        type: "agent",
        agentId: "agent-1",
        companyId: "company-1",
        keyScopes: ["read"],
        source: "agent_key",
      },
    });

    expect(() => assertCompanyAccess(req, "company-1")).toThrow(
      "Agent key scope is read-only",
    );
  });

  it("preserves legacy agent keys that have no stored scope", () => {
    const req = makeReq({
      method: "PATCH",
      actor: {
        type: "agent",
        agentId: "agent-1",
        companyId: "company-1",
        keyScopes: null,
        source: "agent_key",
      },
    });

    expect(() => assertCompanyAccess(req, "company-1")).not.toThrow();
  });

  it("rejects signed-in instance admins without explicit company access", () => {
    const req = makeReq({
      method: "GET",
      actor: {
        type: "board",
        userId: "admin-1",
        source: "session",
        isInstanceAdmin: true,
        companyIds: [],
        memberships: [],
      },
    });

    expect(() => assertCompanyAccess(req, "company-1")).toThrow(
      "User does not have access to this company",
    );
  });

  it("allows local trusted board access without explicit membership", () => {
    const req = makeReq({
      method: "GET",
      actor: {
        type: "board",
        userId: "local-board",
        source: "local_implicit",
        isInstanceAdmin: true,
      },
    });

    expect(() => assertCompanyAccess(req, "company-1")).not.toThrow();
  });
});

describe("assertBoardOrgAccess", () => {
  it("allows signed-in board users with active company access", () => {
    const req = makeReq({
      actor: {
        type: "board",
        userId: "user-1",
        source: "session",
        companyIds: ["company-1"],
        memberships: [
          {
            companyId: "company-1",
            membershipRole: "operator",
            status: "active",
          },
        ],
        isInstanceAdmin: false,
      },
    });

    expect(hasBoardOrgAccess(req)).toBe(true);
    expect(() => assertBoardOrgAccess(req)).not.toThrow();
  });

  it("allows instance admins without company memberships", () => {
    const req = makeReq({
      actor: {
        type: "board",
        userId: "admin-1",
        source: "session",
        companyIds: [],
        memberships: [],
        isInstanceAdmin: true,
      },
    });

    expect(hasBoardOrgAccess(req)).toBe(true);
    expect(() => assertBoardOrgAccess(req)).not.toThrow();
  });

  it("rejects signed-in users without company access or instance admin rights", () => {
    const req = makeReq({
      actor: {
        type: "board",
        userId: "outsider-1",
        source: "session",
        companyIds: [],
        memberships: [],
        isInstanceAdmin: false,
      },
    });

    expect(hasBoardOrgAccess(req)).toBe(false);
    expect(() => assertBoardOrgAccess(req)).toThrow(
      "Company membership or instance admin access required",
    );
  });
});

describe("assertControlPlaneSurfaceAccess", () => {
  it("allows customer surfaces through normal company access", () => {
    const req = makeReq({
      method: "GET",
      actor: {
        type: "board",
        userId: "user-1",
        source: "session",
        companyIds: ["company-1"],
        memberships: [
          {
            companyId: "company-1",
            membershipRole: "viewer",
            status: "active",
          },
        ],
      },
    });

    expect(() =>
      assertControlPlaneSurfaceAccess(req, {
        surface: "customer",
        companyId: "company-1",
      }),
    ).not.toThrow();
  });

  it("fails closed when customer surfaces omit company scope", () => {
    const req = makeReq({
      actor: { type: "board", userId: "user-1", source: "session" },
    });

    expect(() =>
      assertControlPlaneSurfaceAccess(req, { surface: "customer" }),
    ).toThrow("Customer surface requires a company scope");
  });

  it("restricts admin surfaces to instance admins", () => {
    const agentReq = makeReq({
      actor: {
        type: "agent",
        agentId: "agent-1",
        companyId: "company-1",
        source: "agent_key",
      },
    });
    const adminReq = makeReq({
      actor: {
        type: "board",
        userId: "admin-1",
        isInstanceAdmin: true,
        source: "session",
      },
    });

    expect(() =>
      assertControlPlaneSurfaceAccess(agentReq, { surface: "admin" }),
    ).toThrow("Board access required");
    expect(() =>
      assertControlPlaneSurfaceAccess(adminReq, { surface: "admin" }),
    ).not.toThrow();
  });

  it("requires same-company node-private agent access with explicit node_private scope", () => {
    const unscopedReq = makeReq({
      actor: {
        type: "agent",
        agentId: "agent-1",
        companyId: "company-1",
        source: "agent_key",
      },
    });
    const nullScopedReq = makeReq({
      actor: {
        type: "agent",
        agentId: "agent-1",
        companyId: "company-1",
        keyScopes: null,
        source: "agent_key",
      },
    });
    const readOnlyReq = makeReq({
      actor: {
        type: "agent",
        agentId: "agent-1",
        companyId: "company-1",
        keyScopes: ["read"],
        source: "agent_key",
      },
    });
    const wrongCompanyReq = makeReq({
      actor: {
        type: "agent",
        agentId: "agent-1",
        companyId: "company-2",
        keyScopes: ["node_private"],
        source: "agent_key",
      },
    });
    const nodeReq = makeReq({
      actor: {
        type: "agent",
        agentId: "agent-1",
        companyId: "company-1",
        keyScopes: ["read", "node_private"],
        source: "agent_key",
      },
    });

    expect(() =>
      assertControlPlaneSurfaceAccess(unscopedReq, {
        surface: "node_private",
        companyId: "company-1",
      }),
    ).toThrow("Agent key scope does not allow node-private access");
    expect(() =>
      assertControlPlaneSurfaceAccess(nullScopedReq, {
        surface: "node_private",
        companyId: "company-1",
      }),
    ).toThrow("Agent key scope does not allow node-private access");
    expect(() =>
      assertControlPlaneSurfaceAccess(readOnlyReq, {
        surface: "node_private",
        companyId: "company-1",
      }),
    ).toThrow("Agent key scope does not allow node-private access");
    expect(() =>
      assertControlPlaneSurfaceAccess(wrongCompanyReq, {
        surface: "node_private",
        companyId: "company-1",
      }),
    ).toThrow("Node-private surface requires same-company agent access");
    expect(() =>
      assertControlPlaneSurfaceAccess(nodeReq, {
        surface: "node_private",
        companyId: "company-1",
      }),
    ).not.toThrow();
  });
});
