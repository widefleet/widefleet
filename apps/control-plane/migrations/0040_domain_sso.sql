ALTER TABLE organization_settings ADD COLUMN domain_sso_required boolean NOT NULL DEFAULT false;
--> statement-breakpoint
-- Organizations that already require company SSO also own sign-in for their domains.
UPDATE organization_settings SET domain_sso_required = sso_required;
