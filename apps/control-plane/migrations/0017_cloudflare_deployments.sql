ALTER TABLE "fleet" ADD COLUMN "executor" text DEFAULT 'agent' NOT NULL;
--> statement-breakpoint
ALTER TABLE "fleet" ADD CONSTRAINT "fleet_executor_check" CHECK ("executor" IN ('agent', 'cloudflare'));
--> statement-breakpoint
CREATE TABLE "cloudflare_operation" (
  "id" uuid PRIMARY KEY NOT NULL,
  "app_id" uuid NOT NULL REFERENCES "app"("id") ON DELETE CASCADE,
  "sequence" bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  "command" jsonb NOT NULL,
  "targets" jsonb NOT NULL,
  "result" jsonb NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "finished_at" timestamp with time zone,
  "error" text
);
--> statement-breakpoint
CREATE TABLE "cloudflare_runtime_bindings" (
  "scope" text PRIMARY KEY NOT NULL,
  "pending" jsonb
);
