ALTER TABLE "app" ADD COLUMN "service_grants" jsonb DEFAULT '[]'::jsonb NOT NULL;
ALTER TABLE "app" ADD COLUMN "service_access_revision" integer DEFAULT 0 NOT NULL;
ALTER TABLE "app" ADD COLUMN "applied_service_access_revision" integer;
ALTER TABLE "app" ADD COLUMN "service_access_error" text;
ALTER TABLE "job" ADD COLUMN "service_access" jsonb;
