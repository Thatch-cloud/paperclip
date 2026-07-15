DO $$
DECLARE
  has_company_id boolean;
  null_environment_count integer;
  company_count integer;
  sole_company_id uuid;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'environments'
      AND column_name = 'company_id'
  ) INTO has_company_id;

  IF NOT has_company_id THEN
    ALTER TABLE "environments" ADD COLUMN "company_id" uuid;
  END IF;

  SELECT count(*) INTO null_environment_count FROM "environments" WHERE "company_id" IS NULL;
  SELECT count(*) INTO company_count FROM "companies";

  IF null_environment_count > 0 THEN
    IF company_count <> 1 THEN
      RAISE EXCEPTION 'Cannot safely backfill environments.company_id: % null environment row(s), % company row(s)', null_environment_count, company_count;
    END IF;

    SELECT "id" INTO sole_company_id
    FROM "companies"
    ORDER BY "created_at" ASC, "id" ASC
    LIMIT 1;

    UPDATE "environments"
    SET "company_id" = sole_company_id
    WHERE "company_id" IS NULL;
  END IF;

  ALTER TABLE "environments" ALTER COLUMN "company_id" SET NOT NULL;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'environments_company_id_companies_id_fk'
  ) THEN
    ALTER TABLE "environments"
      ADD CONSTRAINT "environments_company_id_companies_id_fk"
      FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id")
      ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DROP INDEX IF EXISTS "environments_company_status_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "environments_company_driver_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "environments_company_name_idx";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "environments_company_status_idx" ON "environments" USING btree ("company_id","status");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "environments_company_driver_idx" ON "environments" USING btree ("company_id","driver") WHERE "driver" = 'local';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "environments_company_name_idx" ON "environments" USING btree ("company_id","name");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "environments_company_managed_sandbox_idx"
  ON "environments" ("company_id")
  WHERE driver = 'sandbox' AND (metadata ->> 'managedByPaperclip')::boolean = true;
