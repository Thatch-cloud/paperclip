CREATE TABLE "control_plane_audit_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE cascade,
  "actor_type" text NOT NULL,
  "actor_id" text NOT NULL,
  "subject_type" text NOT NULL,
  "subject_id" text NOT NULL,
  "action" text NOT NULL,
  "outcome" text NOT NULL,
  "source" text,
  "request_id" text,
  "run_id" uuid REFERENCES "heartbeat_runs"("id") ON DELETE set null,
  "details" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX "control_plane_audit_events_company_created_idx" ON "control_plane_audit_events" ("company_id", "created_at");
CREATE INDEX "control_plane_audit_events_subject_idx" ON "control_plane_audit_events" ("company_id", "subject_type", "subject_id");
CREATE INDEX "control_plane_audit_events_run_idx" ON "control_plane_audit_events" ("run_id");
CREATE INDEX "control_plane_audit_events_request_idx" ON "control_plane_audit_events" ("request_id");

CREATE TABLE "data_governance_records" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE cascade,
  "subject_type" text NOT NULL,
  "subject_id" text NOT NULL,
  "data_class" text NOT NULL,
  "owner_type" text NOT NULL,
  "owner_id" text NOT NULL,
  "residency_region" text,
  "custody_mode" text DEFAULT 'control_plane_metadata_only' NOT NULL,
  "secret_storage_mode" text DEFAULT 'opaque_handle_only' NOT NULL,
  "migration_checklist_ref" text,
  "pitr_restore_drill_ref" text,
  "metadata" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX "data_governance_records_subject_uq" ON "data_governance_records" ("company_id", "subject_type", "subject_id");
CREATE INDEX "data_governance_records_company_class_idx" ON "data_governance_records" ("company_id", "data_class");
CREATE INDEX "data_governance_records_owner_idx" ON "data_governance_records" ("company_id", "owner_type", "owner_id");
