ALTER TABLE "app" ADD COLUMN "access_groups" jsonb DEFAULT '[]'::jsonb NOT NULL;
ALTER TABLE "app" ADD COLUMN "access_revision" integer DEFAULT 0 NOT NULL;
ALTER TABLE "app" ADD COLUMN "applied_access_revision" integer;
ALTER TABLE "app" ADD COLUMN "access_error" text;
ALTER TABLE "job" ADD COLUMN "access" jsonb;

-- Published apps already enforce the revision-zero company SSO policy.
UPDATE "app" SET "applied_access_revision" = 0 WHERE "active_deployment_id" IS NOT NULL;
