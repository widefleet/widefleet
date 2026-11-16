---
title: Authenticate apps to external APIs
description: Use short-lived app identities to call APIs without storing an API key in each app.
lastModified: 2026-11-16
---

Widefleet apps can request a signed token identifying their organization and app.
An external API verifies that token and decides which data the app may access.
This works without a signed-in user and without an API key in the app.

Use matching Widefleet **0.7.2 or newer** releases for the platform, deployment
tools, native agent and app runtime. For an existing installation,
[update the installation components](/self-hosting/installation#versions-and-updates)
and [activate the matching app runtime](/reference/runtime#versions-and-updates).
Run `widefleet runtime status` to check the selected and active versions.

The receiving API must support RS256 JWT verification and trust your installation's
workload issuer.

When upgrading from an EdDSA runtime, update the receiving API and runtime together.
The RS256 runtime publishes a separate RSA key set; previously issued EdDSA tokens
are no longer verifiable through its JWKS. Obtain fresh tokens after the upgrade
and allow receiving APIs to refresh cached keys. Roll back both sides together if needed.

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
| Algorithm              | `RS256`                                                                   |
| Maximum token lifetime | Five minutes                                                              |

Load issuer and key URLs from your API's configuration, never from an unverified
token. Verify the signature, exact issuer, your expected audience and expiry before
using any claims. The trusted app runtime signs tokens and serves the public JWKS. Workload keys
are separate from the keys used for user and CLI authentication.

For an installation with a custom app HTTPS port, include that port in the issuer
and key URLs. Configure your verifier to refresh JWKS when it encounters an unknown
key ID, as `createRemoteJWKSet` does.

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
    algorithms: ["RS256"],
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
  The runtime also applies its existing organization-availability checks when
  configured. Already issued tokens remain valid until their five-minute
  expiry unless the receiving API revokes its grant sooner.

To revoke data access, remove the app's grant on the receiving API. To stop new
token issuance, remove its published route or use the installation's runtime
suspension controls. These changes take effect when they reach the runtime.

Token issuance and key discovery remain available during a control-plane outage
while the app runtime and its storage are healthy. Installation backups must
preserve runtime storage and its encryption key together; see
[backup and restore](/self-hosting/installation#whole-installation-backup-and-restore).

## Troubleshooting

| Symptom                         | Check                                                                                                                                |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `WIDEFLEET_IDENTITY` is missing | Upgrade all platform components. Local standalone Wrangler development needs a test binding; it cannot mint deployed app identities. |
| Token issuance fails            | Check the configured issuer, published app identity, runtime suspension state, and availability of storage and its encryption key.   |
| Signature or issuer is rejected | Use the workload issuer and its advertised JWKS. The receiving library must support RS256.                                           |
| Audience is rejected            | Match the API's configured audience exactly in `getToken`.                                                                           |
| API returns forbidden           | Grant the executing app's ID access on the API; check whether the caller is a preview or a service app.                              |
| Outbound request is blocked     | Allow the API origin in the app's backend network permissions.                                                                       |

For a third-party federation service, check that it accepts your workload issuer,
RS256 signatures and the app identity claims. Use direct verification for APIs you
control, then connect apps to a shared service when several apps need the same
integration.
