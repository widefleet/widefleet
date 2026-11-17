UPDATE "oauth_client"
SET "grant_types" = ARRAY['authorization_code', 'refresh_token'],
    "scopes" = ARRAY['openid', 'profile', 'email', 'offline_access'],
    "updated_at" = now()
WHERE "metadata"->>'purpose' = 'app-login';
