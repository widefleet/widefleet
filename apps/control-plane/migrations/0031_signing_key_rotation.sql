-- Enroll existing keys in rotation without invalidating tokens during upgrade.
-- Better Auth assigns expiry to newly generated keys, but leaves legacy keys alone.
UPDATE "jwks"
SET "expires_at" = CURRENT_TIMESTAMP + INTERVAL '30 days'
WHERE "expires_at" IS NULL;
