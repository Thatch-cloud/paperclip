import type { Db } from "@paperclipai/db";
import { controlPlaneAuditEvents } from "@paperclipai/db";
import { sanitizeRecord } from "../redaction.js";

export type ControlPlaneAuditOutcome =
  "allowed" | "denied" | "succeeded" | "failed";

export type ControlPlaneAuditActor = {
  type: "agent" | "user" | "system" | "node";
  id: string;
};

export type ControlPlaneAuditSubject = {
  type: string;
  id: string;
};

export type RecordControlPlaneAuditEventInput = {
  companyId: string;
  actor: ControlPlaneAuditActor;
  subject: ControlPlaneAuditSubject;
  action: string;
  outcome: ControlPlaneAuditOutcome;
  source?: string | null;
  requestId?: string | null;
  runId?: string | null;
  details?: Record<string, unknown> | null;
};

export function controlPlaneAuditService(db: Db) {
  return {
    async record(input: RecordControlPlaneAuditEventInput) {
      const [event] = await db
        .insert(controlPlaneAuditEvents)
        .values({
          companyId: input.companyId,
          actorType: input.actor.type,
          actorId: input.actor.id,
          subjectType: input.subject.type,
          subjectId: input.subject.id,
          action: input.action,
          outcome: input.outcome,
          source: input.source ?? null,
          requestId: input.requestId ?? null,
          runId: input.runId ?? null,
          details: input.details ? sanitizeRecord(input.details) : null,
        })
        .returning();

      return event;
    },
  };
}

export function auditActorFromRequest(
  req: Express.Request,
): ControlPlaneAuditActor {
  if (req.actor.type === "agent") {
    return { type: "agent", id: req.actor.agentId ?? "unknown-agent" };
  }
  if (req.actor.type === "board") {
    return { type: "user", id: req.actor.userId ?? "board" };
  }
  return { type: "system", id: "unauthenticated" };
}
