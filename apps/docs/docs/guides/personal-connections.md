---
title: Connect personal accounts
description: Let members connect their own accounts to connectors configured by their organization.
lastModified: 2026-11-17
---

Open **My connections** to connect your personal GitHub, Gmail or OneDrive account
to a connector your organization has made available. You need membership and
permission to use that app; you do not need permission to manage its deployment.

Your administrator must first deploy a connector that supports personal
connections. The control plane and app runtime must both support the
`UserConnection` entrypoint described below.

## Connect an account

1. Select the organization you want to use and open **My connections**.
2. Choose **Connect** beside a connector. Its provider opens in the same tab.
3. Select your provider account and approve the requested access.
4. When you return to Widefleet, check the account shown beside **Connected**.

Widefleet reads the status from the connector after you return. Closing or
cancelling authorization does not create a connection. A connector can show
**Status unavailable** when it cannot be reached; this does not mean your account
was disconnected. Use **Refresh** to check again.

Invited members enter this flow after accepting an invitation. Other members
also see it when opening the workspace if connectors are available and they
have not completed this step in the current browser. Choose **Continue to apps**
to skip any remaining accounts. This choice is remembered in a browser cookie
for the current account and organization; another browser or organization can
show the step again. **My connections** remains available afterward.

To remove your account, choose **Disconnect**, then **Disconnect account**.
Apps that use this connector on your behalf lose access until you connect again.
For the included templates, this removes credentials from the connector; you
can separately revoke the application's approval in your provider settings.

## Make a connector available

Deploy the current [GitHub, Gmail or OneDrive template](/guides/app-templates)
and finish its provider setup. Existing copies need the updated connector code
deployed before they appear in **My connections**. The update retains accounts
already stored in the connector, including accounts using your own OAuth app.

The connector must have an active web deployment, be visible in the app catalog
and export `UserConnection`. Preview deployments do not appear. Its existing
[app access rules](/reference/app-access) decide which members can use it.
No separate template registration is needed.

If provider credentials are unavailable, members see that administrator setup is
required. The GitHub, Gmail and OneDrive templates support both operator-provided
OAuth credentials, where configured, and the connector's own credentials. This
feature does not change provider verification or consent requirements.

## Add support to your own connector

Export a named `UserConnection` class extending `WorkerEntrypoint` from your
Worker module. Deployment discovers it from the module's exports; there is no
additional Wrangler setting. Keep a web handler for the authorization launch
and callback routes.

The entrypoint implements these three methods:

| Method                       | Result                           | Behavior                                                            |
| ---------------------------- | -------------------------------- | ------------------------------------------------------------------- |
| `status()`                   | `{ setup, connection, account }` | Read this user's current connection without starting authorization. |
| `prepare({ completionUrl })` | `{ url, expiresAt }`             | Create a short-lived launch URL for this user.                      |
| `disconnect()`               | `{ disconnected: true }`         | Remove only this user's connection.                                 |

`status()` returns this shape:

```ts
type ConnectionStatus = {
  setup: "ready" | "required";
  connection: "connected" | "disconnected";
  account: { id: string; label: string } | null;
};
```

`setup` describes the connector's configuration; `connection` describes the
user's stored account. Keep these independent: an account can remain stored
while administrator setup needs attention. Use a recognizable account name or
email for `label`. Both account fields accept at most 4,096 characters. Do not
return tokens, secrets or provider responses in these results.

Widefleet supplies `this.ctx.props.caller` with `{ issuer, subject, name }`.
Require a caller and use the pair `(issuer, subject)` to identify the user in
all three methods and browser routes. It matches the identity used by ordinary
app requests, including Entra's `oid`. Do not use the member's email or Widefleet
management user ID as an alternative key. See [app user identity](/guides/app-services#user-identity).

`prepare()` receives a completion URL chosen by Widefleet. Return a URL on the
connector's own origin, with an ISO datetime in `expiresAt` no more than five
minutes in the future. The URL must not contain credentials or a fragment.
Use a random, expiring, single-use ticket bound to the caller. The included
templates use a two-minute launch ticket in their existing verification table.

When the browser opens the launch URL, verify the same caller, consume the
ticket atomically and establish any connector-origin session needed by your
OAuth library. Start provider authorization immediately. After success or
cancellation, return the browser to the saved completion URL. Keep the launch
ticket separate from your OAuth library's state and PKCE protections. On
failure, append `connectionError=1` to the completion URL; Widefleet still reads
the actual account status independently.

The [GitHub connector implementation](https://github.com/widefleet/widefleet/tree/main/templates/github/src)
provides a complete example: `app.ts` exports the entrypoint, `connection.ts`
shares its existing authorization and account logic, and `connection-launch.ts`
stores and consumes the tickets. Its OAuth callback remains the connector's
existing callback. Other connectors can use their existing account storage and
authorization mechanism with the same interface.

## Use the CLI or API

Sign in with `widefleet login` and select your organization:

```sh
widefleet --organization ORGANIZATION_ID accounts list
widefleet --organization ORGANIZATION_ID accounts connect APP_UUID
widefleet --organization ORGANIZATION_ID accounts disconnect APP_UUID
```

`accounts list` returns connector IDs and statuses as JSON. `connect` prints
`{ "url": "...", "expiresAt": "..." }`; open that URL in a browser signed in as
the same user. Expired or used links require another `connect` command.
`disconnect` returns `{ "disconnected": true }`.

The corresponding endpoints are `GET /api/v1/user-connections`,
`POST /api/v1/user-connections/{appId}/connect` with `{}`, and
`DELETE /api/v1/user-connections/{appId}`. See the
[API reference](/reference/api#personal-connector-accounts) for authentication.

## Recover a connection

- **Administrator setup required:** ask the connector administrator to finish
  provider configuration. A saved account is retained while setup is incomplete.
- **Sign in with your company account again:** follow **Sign in**, then return
  to **My connections**. Widefleet needs a valid company identity to apply the
  same user mapping and access checks as ordinary app requests.
- **Status unavailable:** refresh after the connector or company directory
  becomes reachable. Do not disconnect an account to fix a temporary outage.
- **Connection link expired or already used:** return to **My connections** and
  choose **Connect** again. A link cannot be shared with another member.

Once the account is shown as connected, open an app that uses the connector.
The app uses that same personal account through its existing connector binding.
