ALTER TABLE "installation" ADD COLUMN "reporting_id" uuid DEFAULT gen_random_uuid() NOT NULL;
--> statement-breakpoint
ALTER TABLE "installation" ADD COLUMN "usage_reporting" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "installation" ADD COLUMN "crash_reporting" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "job" ADD COLUMN "rollback" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "installation" ADD COLUMN "reporting_revision" integer DEFAULT 0 NOT NULL;
