ALTER TABLE "fleet" ADD COLUMN "executor" text DEFAULT 'agent' NOT NULL;
--> statement-breakpoint
ALTER TABLE "fleet" ADD CONSTRAINT "fleet_executor_check" CHECK ("executor" IN ('agent', 'cloudflare'));
--> statement-breakpoint
ALTER TABLE "job" ADD COLUMN "workflow_id" uuid UNIQUE;
--> statement-breakpoint
ALTER TABLE "job_receipt" ALTER COLUMN "agent_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "job_receipt" ALTER COLUMN "lease_token" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "job_receipt" ADD COLUMN "workflow_id" uuid;
--> statement-breakpoint
ALTER TABLE "job_receipt" ADD CONSTRAINT "job_receipt_owner_check" CHECK (
  ("agent_id" IS NOT NULL AND "lease_token" IS NOT NULL AND "workflow_id" IS NULL)
  OR ("agent_id" IS NULL AND "lease_token" IS NULL AND "workflow_id" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "job" ADD COLUMN "activation_started_at" timestamp with time zone;
