import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

export const controlPlaneAuditEvents = pgTable(
  "control_plane_audit_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id").notNull(),
    subjectType: text("subject_type").notNull(),
    subjectId: text("subject_id").notNull(),
    action: text("action").notNull(),
    outcome: text("outcome").notNull(),
    source: text("source"),
    requestId: text("request_id"),
    runId: uuid("run_id").references(() => heartbeatRuns.id, {
      onDelete: "set null",
    }),
    details: jsonb("details").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    companyCreatedIdx: index(
      "control_plane_audit_events_company_created_idx",
    ).on(table.companyId, table.createdAt),
    subjectIdx: index("control_plane_audit_events_subject_idx").on(
      table.companyId,
      table.subjectType,
      table.subjectId,
    ),
    runIdx: index("control_plane_audit_events_run_idx").on(table.runId),
    requestIdx: index("control_plane_audit_events_request_idx").on(
      table.requestId,
    ),
  }),
);
