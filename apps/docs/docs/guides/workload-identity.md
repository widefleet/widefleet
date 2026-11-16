---
title: Authenticate apps to external APIs
description: Use short-lived app identities to call APIs without storing an API key in each app.
lastModified: 2026-11-16
---

Widefleet apps can request a signed token identifying their organization and app.
An external API verifies that token and decides which data the app may access.
This works without a signed-in user and without an API key in the app.

Upgrade the control plane and app runtime before using
the `WIDEFLEET_IDENTITY` binding. The receiving API must support EdDSA JWT
verification and trust your installation's workload issuer.

## Call an API from an app

The runtime provides `WIDEFLEET_IDENTITY` automatically to deployed apps, including
headless services and previews. Do not declare it in `wrangler.jsonc`.

The following Worker calls a data API using `https://data.example.com` as its
audience. Replace the API address and audience with the receiving API's values.

```ts
type Environment = {
  WIDEFLEET_IDENTITY: {
    getToken(audience: string): Promise<{ token: string; expiresAt: number }>;
  };
};

export default {
  async fetch(_request: Request, env: Environment) {
    const { token } = await env.WIDEFLEET_IDENTITY.getToken("https://data.example.com");
    const response = await fetch("https://data.example.com/orders", {
      headers: { authorization: `Bearer ${token}` },
      redirect: "manual",
    });

    if (!response.ok) return new Response("Data API request failed", { status: 502 });
    return Response.json(await response.json());
  },
};
```

Deploy the app and allow its outbound API origin:

```sh
widefleet deploy
widefleet network allow https://data.example.com
```

After the receiving API grants this app access, opening the authenticated app URL
returns its orders. Keep tokens in server-side code: do not return them to the
browser or write them to logs. Cache a token only until shortly before `expiresAt`,
which is a Unix timestamp in seconds. A fresh `getToken` call issues a fresh token;
there is no refresh token.

The audience is an exact, case-sensitive identifier chosen by the receiving API.
It can be a URL or another nonempty printable ASCII string without spaces, up to
2048 characters. Widefleet does not require audience registration and does not
contact the audience. [Network permissions](/guides/network) still govern the
app's outbound HTTP requests.

## Verify and authorize on the receiving API

For an installation with app domain `apps.example.com`, configure these trusted values:

| Setting                | Value                                                                     |
| ---------------------- | ------------------------------------------------------------------------- |
| Issuer                 | `https://auth.apps.example.com/workload`                                  |
| Discovery document     | `https://auth.apps.example.com/workload/.well-known/openid-configuration` |
| JWKS URL               | `https://auth.apps.example.com/workload/jwks`                             |
| Algorithm              | `EdDSA`                                                                   |
| Maximum token lifetime | Five minutes                                                              |

Load issuer and key URLs from your API's configuration, never from an unverified
token. Verify the signature, exact issuer, your expected audience and expiry before
using any claims. The trusted app runtime signs tokens and serves the public JWKS. Workload keys
are separate from the keys used for user and CLI authentication.

For a JavaScript API, install `jose` and use a verification function like this:

```sh
pnpm add jose
```

```ts
import { createRemoteJWKSet, jwtVerify } from "jose";

const issuer = "https://auth.apps.example.com/workload";
const audience = "https://data.example.com";
const keys = createRemoteJWKSet(new URL("https://auth.apps.example.com/workload/jwks"));

// Configure this mapping on the receiving API using the organization's and
// app's actual IDs. The value selects a data scope owned by this API.
const grants = new Map([
  ["organization:example:app:11111111-1111-4111-8111-111111111111", "example-data"],
]);

export async function authorizeWorkload(token: string) {
  const { payload } = await jwtVerify(token, keys, {
    issuer,
    audience,
    algorithms: ["EdDSA"],
    requiredClaims: ["sub", "exp", "iat", "jti"],
    maxTokenAge: "5m",
  });

  const organizationId = payload["organization_id"];
  const appId = payload["app_id"];
  if (
    payload["workload_type"] !== "app" ||
    typeof organizationId !== "string" ||
    typeof appId !== "string" ||
    payload.sub !== `organization:${organizationId}:app:${appId}`
  ) {
    throw new Error("Invalid workload identity");
  }

  const dataScope = grants.get(payload.sub);
  if (!dataScope) throw new Error("App has no data access");
  return { organizationId, appId, dataScope };
}
```

Pass the Bearer token from the incoming request to this function. Reject the
request if verification or authorization fails. Use the returned `dataScope` to
restrict database queries; do not let a request parameter select another
organization's data. A valid token proves identity, while the API's grant determines
access. Requesting your API's audience alone gives an app no data permissions.

## Identity and lifecycle

- `sub` has the form `organization:ORGANIZATION_ID:app:APP_UUID`. Deployments and
  rollbacks preserve that identity. Deleting and recreating an app produces a new
  app ID.
- `organization_id`, `app_id` and `workload_type: "app"` identify the executing app.
  The runtime supplies them; app code supplies only the audience.
- Service calls use the service app's identity. Grant the service app data access
  when it owns the external integration, then connect callers through
  [app services](/guides/app-services).
- Previews have independent app IDs and need their own API grants. A parent's
  permissions do not authorize its previews.
- Tokens contain no user identity or user permissions. They work in HTTP, service,
  cron, queue and Workflow code. User-specific access requires a separate check by
  the app or service.
- An app stops receiving tokens when its published route is removed or replaced.
  Organization admission changes take effect when their updated configuration
  reaches the runtime. Already issued tokens remain valid until their five-minute
  expiry unless the receiving API revokes its grant sooner.

The runtime issues tokens and serves discovery and JWKS without contacting the
control plane or its database. This also works after runtime restarts. The existing
runtime storage must remain available; the private signing keys are encrypted with
the runtime's existing secret-encryption key and stay outside app code.

The control plane publishes a complete organization-admission snapshot at startup
and every minute on native installations. Hosted installations use the reserved
`0-59 * * * *` control-plane cron; custom extension schedules remain separate.
Allow initial publication to complete after deploying the components. A runtime
with no published configuration refuses issuance.

Publication includes organization-access extensions and database suspension state.
Subsequent changes normally arrive on the next reconciliation plus storage
propagation. Publication failures are reported and retried on the next run. During
a control-plane outage, the last published snapshot remains valid indefinitely:
existing workloads continue issuing fresh tokens, but new admission changes cannot
arrive. There is no hard upper bound on suspension delay during such an outage.
Existing runtime suspension checks still apply as well.

Each installation's runtime storage holds its workload key ring. Runtime replicas
sharing that storage use the same ring. Conditional writes coordinate concurrent
initialization and rotation. Back up that storage and the runtime's secret-encryption
key together so restarts and recovery preserve the issuer's signing authority.

The runtime prepares the next signing key in advance and includes its public key
in JWKS immediately. It activates after 30 days; the next access prepares its
successor. Rotation needs no control-plane job. Retired public keys remain available
through the five-minute token lifetime plus a one-minute margin. Metadata responses
can be cached for 60 seconds. Receivers should refresh JWKS on an unknown key ID,
as `createRemoteJWKSet` does. User and CLI signing keys are unaffected.

## Troubleshooting

| Symptom                         | Check                                                                                                                                 |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `WIDEFLEET_IDENTITY` is missing | Upgrade all platform components. Local standalone Wrangler development needs a test binding; it cannot mint deployed app identities.  |
| Token issuance fails            | Check that the app is published, organization admission has been published, and runtime storage and its encryption key are available. |
| Signature or issuer is rejected | Use the workload issuer and its advertised JWKS. The receiving library must support EdDSA.                                            |
| Audience is rejected            | Match the API's configured audience exactly in `getToken`.                                                                            |
| API returns forbidden           | Grant the executing app's ID access on the API; check whether the caller is a preview or a service app.                               |
| Outbound request is blocked     | Allow the API origin in the app's backend network permissions.                                                                        |

Discovery and JWKS are served directly by the parent runtime on the existing
`auth.<app-domain>` host. Native installations with a custom app HTTPS port include
that port in the issuer. The management hostname and internal control-plane
address are not used for token issuance or verification.

The discovery document describes these workload JWTs. Tokens are issued only
through the runtime binding; there is no public OAuth token-exchange or
client-credentials endpoint. A third-party federation service needs to support this
issuer's signing algorithm and token contract. Use direct verification for APIs
you control, then connect apps to a shared service when several apps need the same
integration.
