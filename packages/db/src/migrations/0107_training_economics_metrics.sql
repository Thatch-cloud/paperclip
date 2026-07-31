CREATE TABLE "training_economics_metrics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"workload_type" text DEFAULT 'managed_fine_tune' NOT NULL,
	"job_id" text,
	"lane_id" text,
	"node_id" text,
	"node_config_id" text,
	"unit_hours" double precision DEFAULT 0 NOT NULL,
	"unit_hours_provenance" text DEFAULT 'modelled' NOT NULL,
	"cost_cents" integer DEFAULT 0 NOT NULL,
	"cost_provenance" text DEFAULT 'modelled' NOT NULL,
	"revenue_cents" integer DEFAULT 0 NOT NULL,
	"revenue_provenance" text DEFAULT 'modelled' NOT NULL,
	"node_utilization_percent" double precision,
	"node_utilization_provenance" text DEFAULT 'modelled',
	"flip_recommendation" text,
	"flip_recommendation_provenance" text DEFAULT 'modelled',
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "training_economics_metrics" ADD CONSTRAINT "training_economics_metrics_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "training_economics_metrics_company_period_idx" ON "training_economics_metrics" USING btree ("company_id","period_start","period_end");--> statement-breakpoint
CREATE INDEX "training_economics_metrics_company_workload_idx" ON "training_economics_metrics" USING btree ("company_id","workload_type");
