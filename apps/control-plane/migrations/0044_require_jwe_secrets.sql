-- Releases from this one on read stored secrets only as JWE compact serializations.
-- Values in the earlier format must be re-encrypted on the previous release first.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM app, jsonb_each_text(app.secrets) AS secret
    WHERE secret.value !~ '^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'
  ) OR EXISTS (
    SELECT 1 FROM organization_settings
    WHERE directory_secret !~ '^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'
      OR app_client_secret !~ '^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'
      OR settings #>> '{identity,management,secret,ciphertext}' !~ '^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'
  ) OR EXISTS (
    SELECT 1 FROM sso_provider
    WHERE oidc_config !~ '^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'
      OR saml_config !~ '^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'
  ) THEN
    RAISE EXCEPTION 'Stored secrets still use the encryption format of earlier releases. Run "node tools/secret-encryption.ts reencrypt" on the previous release first, then upgrade.';
  END IF;
END $$;
