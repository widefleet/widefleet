CREATE TABLE "cloudflare_resource_creation" (
  "scope" text PRIMARY KEY NOT NULL,
  "id" uuid NOT NULL,
  "app_id" uuid NOT NULL REFERENCES "app"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "name" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "cloudflare_resource_creation_app_idx" ON "cloudflare_resource_creation" ("app_id");
