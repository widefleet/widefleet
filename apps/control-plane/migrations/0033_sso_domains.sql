CREATE TABLE sso_domain (
  organization_id text NOT NULL REFERENCES sso_provider(organization_id) ON DELETE CASCADE,
  domain text NOT NULL,
  verification_token text NOT NULL,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, domain)
);
--> statement-breakpoint
CREATE UNIQUE INDEX sso_domain_verified_idx ON sso_domain(domain) WHERE verified_at IS NOT NULL;
--> statement-breakpoint
-- Keep a pending Better Auth token valid so a published TXT record still verifies.
INSERT INTO sso_domain (organization_id, domain, verification_token, verified_at)
SELECT DISTINCT ON (provider.organization_id, listed.domain)
  provider.organization_id,
  listed.domain,
  coalesce(
    (
      SELECT pending.value FROM verification pending
      WHERE pending.identifier = '_better-auth-token-' || provider.provider_id
        AND pending.expires_at > now()
      ORDER BY pending.created_at DESC
      LIMIT 1
    ),
    replace(gen_random_uuid()::text, '-', '')
  ),
  CASE WHEN provider.domain_verified THEN now() END
FROM sso_provider provider
CROSS JOIN LATERAL (
  SELECT lower(trim(entry)) AS domain FROM unnest(string_to_array(provider.domain, ',')) AS entry
) listed
WHERE listed.domain <> '';
