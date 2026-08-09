CREATE TABLE "health_write_canaries" (
  "singleton_key" text PRIMARY KEY NOT NULL,
  "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
