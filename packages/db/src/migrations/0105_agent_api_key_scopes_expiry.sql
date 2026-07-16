ALTER TABLE "agent_api_keys" ADD COLUMN "scopes" jsonb;
ALTER TABLE "agent_api_keys" ADD COLUMN "expires_at" timestamp with time zone;
