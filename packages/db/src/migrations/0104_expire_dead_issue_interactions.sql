UPDATE "issue_thread_interactions" AS t
SET
  "status" = 'expired',
  "resolved_at" = COALESCE(t."resolved_at", NOW()),
  "updated_at" = NOW()
FROM "issues" AS i
WHERE i."id" = t."issue_id"
  AND i."company_id" = t."company_id"
  AND i."status" IN ('done', 'cancelled')
  AND t."status" = 'pending';
