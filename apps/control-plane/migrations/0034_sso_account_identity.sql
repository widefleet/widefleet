-- Entra's `sub` is pairwise per app registration; app sign-in identifies Entra
-- users by object ID. Key management accounts the same way, from the ID token
-- saved at their last sign-in.
UPDATE account
SET account_id = claims.oid
FROM (
  SELECT
    account.id,
    convert_from(
      decode(
        rpad(
          translate(split_part(account.id_token, '.', 2), '-_', '+/'),
          ((length(split_part(account.id_token, '.', 2)) + 3) / 4) * 4,
          '='
        ),
        'base64'
      ),
      'UTF8'
    )::jsonb ->> 'oid' AS oid
  FROM account
  JOIN sso_provider ON sso_provider.provider_id = account.provider_id
  WHERE sso_provider.app_identity_type = 'entra'
    AND account.id_token ~ '^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.'
) claims
WHERE account.id = claims.id AND claims.oid IS NOT NULL;
