import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const healthWriteCanaries = pgTable("health_write_canaries", {
  singletonKey: text("singleton_key").primaryKey(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
