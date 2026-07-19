import type { Request } from "express";
import { forbidden, unauthorized } from "../errors.js";

export function assertAuthenticated(req: Request) {
  if (req.actor.type === "none") {
    throw unauthorized();
  }
}

export function assertBoard(req: Request) {
  if (req.actor.type !== "board") {
    throw forbidden("Board access required");
  }
}

export function hasBoardOrgAccess(req: Request) {
  if (req.actor.type !== "board") {
    return false;
  }
  if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) {
    return true;
  }
  return Array.isArray(req.actor.companyIds) && req.actor.companyIds.length > 0;
}

export function assertBoardOrgAccess(req: Request) {
  assertBoard(req);
  if (hasBoardOrgAccess(req)) {
    return;
  }
  throw forbidden("Company membership or instance admin access required");
}

export function assertBoardOrAgent(req: Request) {
  if (req.actor.type === "agent") {
    return;
  }
  if (req.actor.type === "board") {
    assertBoardOrgAccess(req);
    return;
  }
  throw forbidden("Board or agent access required");
}

export function assertInstanceAdmin(req: Request) {
  assertBoard(req);
  if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) {
    return;
  }
  throw forbidden("Instance admin access required");
}

export type ControlPlaneSurface = "customer" | "admin" | "node_private";

export function assertControlPlaneSurfaceAccess(
  req: Request,
  input: { surface: ControlPlaneSurface; companyId?: string | null },
) {
  if (input.surface === "customer") {
    if (!input.companyId)
      throw forbidden("Customer surface requires a company scope");
    assertCompanyAccess(req, input.companyId);
    return;
  }

  if (input.surface === "admin") {
    assertInstanceAdmin(req);
    return;
  }

  if (input.surface === "node_private") {
    assertAuthenticated(req);
    if (!input.companyId)
      throw forbidden("Node-private surface requires a company scope");
    if (req.actor.type !== "agent" || req.actor.companyId !== input.companyId) {
      throw forbidden(
        "Node-private surface requires same-company agent access",
      );
    }
    if (
      !Array.isArray(req.actor.keyScopes) ||
      !req.actor.keyScopes.includes("node_private")
    ) {
      throw forbidden("Agent key scope does not allow node-private access");
    }
    return;
  }

  throw forbidden("Unsupported control-plane surface");
}

export function assertCompanyAccess(req: Request, companyId: string) {
  assertAuthenticated(req);
  if (req.actor.type === "agent" && req.actor.companyId !== companyId) {
    throw forbidden("Agent key cannot access another company");
  }
  if (req.actor.type === "agent" && Array.isArray(req.actor.keyScopes)) {
    const method =
      typeof req.method === "string" ? req.method.toUpperCase() : "GET";
    const isSafeMethod = ["GET", "HEAD", "OPTIONS"].includes(method);
    if (isSafeMethod) {
      if (
        !req.actor.keyScopes.includes("read") &&
        !req.actor.keyScopes.includes("write")
      ) {
        throw forbidden("Agent key scope does not allow reads");
      }
    } else if (!req.actor.keyScopes.includes("write")) {
      throw forbidden("Agent key scope is read-only");
    }
  }
  if (req.actor.type === "board" && req.actor.source !== "local_implicit") {
    const allowedCompanies = req.actor.companyIds ?? [];
    if (!allowedCompanies.includes(companyId)) {
      throw forbidden("User does not have access to this company");
    }
    const method =
      typeof req.method === "string" ? req.method.toUpperCase() : "GET";
    const isSafeMethod = ["GET", "HEAD", "OPTIONS"].includes(method);
    if (
      !isSafeMethod &&
      !req.actor.isInstanceAdmin &&
      Array.isArray(req.actor.memberships)
    ) {
      const membership = req.actor.memberships.find(
        (item) => item.companyId === companyId,
      );
      if (!membership || membership.status !== "active") {
        throw forbidden("User does not have active company access");
      }
      if (membership.membershipRole === "viewer") {
        throw forbidden("Viewer access is read-only");
      }
    }
  }
}

export function getActorInfo(req: Request) {
  assertAuthenticated(req);
  if (req.actor.type === "agent") {
    return {
      actorType: "agent" as const,
      actorId: req.actor.agentId ?? "unknown-agent",
      agentId: req.actor.agentId ?? null,
      runId: req.actor.runId ?? null,
    };
  }

  return {
    actorType: "user" as const,
    actorId: req.actor.userId ?? "board",
    agentId: null,
    runId: req.actor.runId ?? null,
  };
}
