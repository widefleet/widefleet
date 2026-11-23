ALTER TABLE "organization_settings" ADD COLUMN "join_domains" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "organization_settings" ADD COLUMN "restrict_organization_creation" boolean DEFAULT false NOT NULL;
