ALTER TABLE "organization_runtime" ADD COLUMN "http_blocked" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "organization_runtime" ADD COLUMN "http_availability_pending" boolean NOT NULL DEFAULT false;
