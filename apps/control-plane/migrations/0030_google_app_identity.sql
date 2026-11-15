ALTER TABLE "sso_provider"
  DROP CONSTRAINT "sso_provider_app_identity_type_check",
  ADD CONSTRAINT "sso_provider_app_identity_type_check"
    CHECK ("app_identity_type" IN ('oidc', 'entra', 'google'));
