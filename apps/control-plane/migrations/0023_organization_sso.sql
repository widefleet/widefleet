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
  "oidc_config" text,
  "saml_config" text,
  "user_id" text REFERENCES "user"("id") ON DELETE SET NULL,
  "organization_id" text NOT NULL UNIQUE REFERENCES "organization"("id") ON DELETE CASCADE
);
