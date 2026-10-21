CREATE TABLE "organization_settings" (
  "organization_id" text PRIMARY KEY REFERENCES "organization"("id"),
  "settings" jsonb NOT NULL
);
--> statement-breakpoint
INSERT INTO "organization_settings" ("organization_id", "settings")
SELECT 'widefleet', "settings" FROM "installation" WHERE "id" = 'widefleet';
--> statement-breakpoint
ALTER TABLE "installation" DROP COLUMN "settings";
--> statement-breakpoint
ALTER TABLE "installation_secret" RENAME TO "organization_secret";
--> statement-breakpoint
ALTER TABLE "organization_secret" ADD COLUMN "organization_id" text NOT NULL DEFAULT 'widefleet' REFERENCES "organization"("id");
--> statement-breakpoint
ALTER TABLE "organization_secret" ALTER COLUMN "organization_id" DROP DEFAULT;

