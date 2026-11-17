ALTER TABLE "app" ADD COLUMN "secrets" jsonb NOT NULL DEFAULT '{}';
ALTER TABLE "app" ADD COLUMN "secret_revision" integer NOT NULL DEFAULT 0;
ALTER TABLE "app" ADD COLUMN "applied_secret_revision" integer;
ALTER TABLE "app" ADD COLUMN "secret_deployment_id" uuid;
ALTER TABLE "job" ADD COLUMN "app_secrets" jsonb;
ALTER TABLE "app" ADD COLUMN "web_enabled" boolean NOT NULL DEFAULT true;

-- Breaking cutover: old connector grants and pending operations are not migrated.
UPDATE "app" SET "capabilities" = '{}', "applied_capabilities" = NULL,
  "capability_revision" = "capability_revision" + 1, "applied_capability_revision" = NULL,
  "capability_error" = NULL WHERE "capabilities" <> '{}'::jsonb OR "applied_capabilities" IS NOT NULL;
UPDATE "job" SET "capabilities" = NULL WHERE "capabilities" IS NOT NULL;
DELETE FROM "job" WHERE "kind" = 'connector';
DELETE FROM "cloudflare_operation" WHERE "command"->>'kind' IN ('connector', 'capabilities');
DROP TABLE "connector";
ALTER TABLE "job" DROP COLUMN "connector";
ALTER TABLE "job" DROP COLUMN "connectors";
