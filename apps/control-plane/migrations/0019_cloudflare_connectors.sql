ALTER TABLE "cloudflare_operation" ALTER COLUMN "app_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "cloudflare_operation" ADD COLUMN "fleet_id" uuid REFERENCES "fleet"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "cloudflare_operation" ADD CONSTRAINT "cloudflare_operation_scope_check" CHECK (num_nonnulls("app_id", "fleet_id") = 1);
--> statement-breakpoint
ALTER TABLE "app" ADD COLUMN "applied_capabilities" jsonb;
