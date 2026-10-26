ALTER TABLE "app" ADD COLUMN "removed_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "app" DROP CONSTRAINT "app_hostname_unique";
--> statement-breakpoint
DROP INDEX "app_organization_slug_unique";
--> statement-breakpoint
CREATE UNIQUE INDEX "app_hostname_unique" ON "app" ("hostname") WHERE "removed_at" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "app_organization_slug_unique" ON "app" ("organization_id", "slug") WHERE "removed_at" IS NULL;
