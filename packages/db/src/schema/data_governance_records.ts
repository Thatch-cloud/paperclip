import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const dataGovernanceRecords = pgTable(
  "data_governance_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    subjectType: text("subject_type").notNull(),
    subjectId: text("subject_id").notNull(),
    dataClass: text("data_class").notNull(),
    ownerType: text("owner_type").notNull(),
    ownerId: text("owner_id").notNull(),
    residencyRegion: text("residency_region"),
    custodyMode: text("custody_mode")
      .notNull()
      .default("control_plane_metadata_only"),
    secretStorageMode: text("secret_storage_mode")
      .notNull()
      .default("opaque_handle_only"),
    migrationChecklistRef: text("migration_checklist_ref"),
    pitrRestoreDrillRef: text("pitr_restore_drill_ref"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    subjectUq: uniqueIndex("data_governance_records_subject_uq").on(
      table.companyId,
      table.subjectType,
      table.subjectId,
    ),
    companyClassIdx: index("data_governance_records_company_class_idx").on(
      table.companyId,
      table.dataClass,
    ),
    ownerIdx: index("data_governance_records_owner_idx").on(
      table.companyId,
      table.ownerType,
      table.ownerId,
    ),
  }),
);
