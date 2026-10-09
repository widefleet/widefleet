CREATE TABLE "installation" (
  "id" text PRIMARY KEY NOT NULL,
  "settings" jsonb NOT NULL,
  "owner_id" text REFERENCES "user"("id"),
  "local_password_enabled" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "installation_secret" (
  "id" text PRIMARY KEY NOT NULL,
  "ciphertext" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "company_configuration" text DEFAULT '' NOT NULL;

--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "recovery" boolean DEFAULT false NOT NULL;
