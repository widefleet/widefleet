ALTER TABLE "session" ADD COLUMN "identity_organization_id" text;
--> statement-breakpoint
UPDATE "session" SET "identity_organization_id" = 'widefleet' WHERE "company_configuration" <> '' OR "recovery" = true;
--> statement-breakpoint
ALTER TABLE "device_code" ADD COLUMN "reference_id" text, ADD COLUMN "session_id" text, ADD COLUMN "auth_time" timestamp;
--> statement-breakpoint
-- Older settings contain no company-domain proof. Preserve their credentials above;
-- provider activation requires saving the domain and verifying DNS, using operator
-- recovery when password/email sign-in is unavailable. Do not infer domain ownership.
CREATE TABLE "sso_provider" (
  "id" text PRIMARY KEY,
  "provider_id" text NOT NULL UNIQUE,
  "issuer" text NOT NULL,
  "domain" text NOT NULL,
  "domain_verified" boolean NOT NULL DEFAULT false,
  "app_identity_type" text NOT NULL DEFAULT 'oidc' CHECK ("app_identity_type" IN ('oidc', 'entra')),
  "oidc_config" text,
  "saml_config" text,
  "user_id" text REFERENCES "user"("id") ON DELETE SET NULL,
  "organization_id" text NOT NULL UNIQUE REFERENCES "organization"("id") ON DELETE CASCADE
);

--> statement-breakpoint
ALTER TABLE "organization_settings" ADD COLUMN "directory_secret" text;
--> statement-breakpoint
UPDATE "organization_settings" AS settings
SET "directory_secret" = secret."ciphertext"
FROM "organization_secret" AS secret
WHERE secret."organization_id" = settings."organization_id"
  AND secret."id" = settings."settings" #>> '{identity,directory,secret,id}';
--> statement-breakpoint
-- Keep the encrypted legacy login credential until the one-time plugin conversion.
UPDATE "organization_settings" AS settings
SET "settings" = jsonb_set(settings."settings", '{identity,management,secret}',
  jsonb_build_object('ciphertext', secret."ciphertext"))
FROM "organization_secret" AS secret
WHERE secret."organization_id" = settings."organization_id"
  AND secret."id" = settings."settings" #>> '{identity,management,secret,id}';
--> statement-breakpoint
UPDATE "organization_settings"
SET "settings" = "settings" #- '{identity,directory,secret}';
--> statement-breakpoint
DROP TABLE "organization_secret";

--> statement-breakpoint
ALTER TABLE "organization_settings" ADD COLUMN "sso_required" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "installation" ADD COLUMN "bootstrap_pending" boolean NOT NULL DEFAULT false;
