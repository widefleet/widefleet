-- Releases from this one no longer convert the company SSO configuration that
-- releases before 0.4.0 stored in organization_settings.settings.identity.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM organization_settings WHERE settings ? 'identity') THEN
    RAISE EXCEPTION 'Company SSO settings still use the configuration format of earlier releases. Start the previous release once so it converts the earlier SSO configuration, then upgrade.';
  END IF;
END $$;
