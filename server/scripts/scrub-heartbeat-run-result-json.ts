import { and, eq, isNotNull, sql } from "drizzle-orm";
import { createDb, heartbeatRuns } from "@paperclipai/db";
import { redactEventPayload } from "../src/redaction.js";

function parseObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

// A broad hint regex that matches result_json values the redaction utility would
// likely mutate. Used only to narrow the candidate set; the final decision is
// made by comparing the sanitized JSON to the original.
const SECRET_HINT_RE = new RegExp(
  [
    "api[_-]?key",
    "access[_-]?token",
    "auth[_-]?token",
    "authorization",
    "bearer",
    "secret",
    "passwd",
    "password",
    "credential",
    "jwt",
    "private[_-]?key",
    "cookie",
    "connectionstring",
    "sk-",
    "ghp_",
    "gho_",
    "ghu_",
    "ghs_",
    "ghr_",
    "github_pat",
  ].join("|"),
  "i",
);

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }

  const apply = process.argv.includes("--apply");
  const batchSizeArg = process.argv.find((arg, index, args) => args[index - 1] === "--batch-size" && arg);
  const batchSize = Math.max(1, Number(batchSizeArg ?? 1000));
  const sinceDaysArg = process.argv.find((arg, index, args) => args[index - 1] === "--since-days" && arg);
  const sinceDays = Math.max(0, Number(sinceDaysArg ?? 0));
  const db = createDb(dbUrl);

  try {
    let processed = 0;
    let changed = 0;
    let lastId: string | null = null;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const conditions = [isNotNull(heartbeatRuns.resultJson)];
      if (lastId) {
        conditions.push(sql`${heartbeatRuns.id} > ${lastId}`);
      }
      if (sinceDays > 0) {
        conditions.push(sql`${heartbeatRuns.startedAt} > now() - ${sql.raw(`${sinceDays} * interval '1 day'`)}`);
      }
      conditions.push(sql`${heartbeatRuns.resultJson}::text ~* ${SECRET_HINT_RE.source}`);

      const rows = await db
        .select({ id: heartbeatRuns.id, resultJson: heartbeatRuns.resultJson })
        .from(heartbeatRuns)
        .where(and(...conditions))
        .orderBy(heartbeatRuns.id)
        .limit(batchSize);

      if (rows.length === 0) break;

      for (const row of rows) {
        processed += 1;
        lastId = row.id;
        const original = parseObject(row.resultJson);
        if (!original) continue;
        const sanitized = redactEventPayload(original);
        if (!sanitized) continue;
        if (JSON.stringify(original) === JSON.stringify(sanitized)) continue;

        changed += 1;
        if (apply) {
          await db
            .update(heartbeatRuns)
            .set({ resultJson: sanitized, updatedAt: new Date() })
            .where(eq(heartbeatRuns.id, row.id));
        }
      }

      if (rows.length < batchSize) break;
    }

    if (!apply) {
      console.log(`Dry run: ${processed} candidate rows examined, ${changed} would be updated`);
      console.log("Re-run with --apply to persist changes");
      return;
    }

    console.log(`Updated ${changed} heartbeat_runs result_json rows (examined ${processed})`);
  } finally {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (db as any).$client?.end?.();
  }
}

void main();
