---
title: Gmail connector example
description: Copy a connector that links personal Google accounts with Better Auth and D1.
lastModified: 2026-10-29
---

Deploy the [Gmail example](https://github.com/widefleet/widefleet/tree/main/examples/connectors/gmail)
to let users connect their own Google accounts and read Gmail from your apps.
The example owns its OAuth flow, connection page and D1 storage. Apps call its
ordinary binding; no authentication SDK is required in the app.

## Prerequisites

- An organization administrator account and a signed-in Widefleet CLI.
- Matching control-plane, CLI, deployment-agent and app-runtime versions with
  [verified connector callers and browser pages](/guides/connectors#user-identity-and-connector-pages).
  Configure organization sign-in and a public HTTPS connector address first.
- Node.js 24 or newer and pnpm 12.4.2 for the connector project.
- A Google Cloud project where you can enable Gmail API and create an OAuth client.

## Copy and deploy

Copy the complete example directory, including its lockfile and package-manager
configuration, into your own repository:

```sh
git clone --depth 1 https://github.com/widefleet/widefleet.git
cp -R widefleet/examples/connectors/gmail gmail-connector
cd gmail-connector
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
```

The tests use local D1 and synthetic Google responses. They do not require Google
credentials or send email.

In Google Cloud, enable **Gmail API**, configure the OAuth consent screen and create
a **Web application** OAuth client. For an external application in Testing mode,
add your intended Google accounts as test users. Set `GOOGLE_CLIENT_ID` in
`wrangler.jsonc` to that client's ID, then deploy:

```sh
widefleet connector deploy
widefleet connector show gmail --json
```

Wait for the connector's activation to succeed. Copy the returned `browserUrl`.
The connector's callback path is `/auth/callback/google`. For example, a
`browserUrl` of `https://gmail-team.apps.example.com/` requires this exact
**Authorized redirect URI** in your Google OAuth client:

```text
https://gmail-team.apps.example.com/auth/callback/google
```

The same callback serves every app that receives this connector. Adding an app
binding requires no change to the Google OAuth client.

Set these secrets in **Connectors → gmail → Manage connector → Secrets**:

| Secret                 | Value                                                                                                                      |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `GOOGLE_CLIENT_SECRET` | The secret of the Google OAuth client above.                                                                               |
| `AUTH_SECRET`          | A persistent random secret of at least 32 characters, generated with a password manager or cryptographic random generator. |

Alternatively, put each value in a protected file outside the project and use:

```sh
widefleet connector secret put gmail GOOGLE_CLIENT_SECRET --file /absolute/path/to/google-client-secret.txt
widefleet connector secret put gmail AUTH_SECRET --file /absolute/path/to/auth-secret.txt
```

Keep `AUTH_SECRET` backed up with the connector's D1 data. Better Auth encrypts the
saved access and refresh tokens with it. Replacing it prevents existing tokens
from being decrypted and requires users to reconnect. The connector initializes
its D1 tables on first use; there is no manual D1 provisioning step.

The requested scopes are Google profile, email and `gmail.readonly`.
Google classifies `gmail.readonly` as a restricted scope. Check the
[Google verification requirements](https://developers.google.com/workspace/gmail/api/auth/scopes)
for your application's audience and data use before distributing it beyond testing.

## Connect a user and an app

Open `browserUrl`, sign in through the organization's identity provider, then choose
**Connect Google account**. Select a Google account and approve the requested
permissions. The callback returns to the connector page, which displays the linked
email address. Return to your app and retry its Gmail action.

Give an existing app the binding:

```sh
widefleet connector bind gmail --as GMAIL --app inbox
```

The app's server code can call:

```ts
const result = await env.GMAIL.listMessages({ maxResults: 20 });
```

Use these connector methods:

| Method                                      | Result                                                                                                                                                         |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `connectionStatus()`                        | `{ connected, googleAccountId }` describing the saved link; it does not check token validity with Google.                                                      |
| `listMessages({ maxResults?, pageToken? })` | On success, `{ status: "connected", messages, nextPageToken? }`. Each message has `id` and `threadId`. The default page size is 20; the example permits 1–100. |
| `getMessage(id)`                            | On success, `{ status: "connected", message }` with the message ID, thread ID, snippet and headers. It requests metadata, not the full message body.           |

The Gmail methods return a status when user action or a retry is needed:

| Status                | App behavior                                                                                                                                   |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `connection_required` | Show the connection link.                                                                                                                      |
| `permission_required` | Ask the user to reconnect and grant Gmail access.                                                                                              |
| `refresh_failed`      | Offer a retry and a reconnection link. Better Auth does not distinguish a temporary refresh failure from revoked credentials in this response. |
| `reconnect_required`  | Google rejected the access token with HTTP 401; offer reconnection.                                                                            |
| `access_denied`       | Google returned HTTP 403. Check granted scopes, Gmail API enablement and Google Workspace policy.                                              |

Other errors, including rate limits and provider outages during a Gmail API call,
reject the RPC call. Apply the app's usual error handling. Never render message
snippets or header values as unescaped HTML.

The app can open the connector page in another tab so its own state remains available:

```html
<a href="/_widefleet/connectors/GMAIL/" target="_blank" rel="noopener noreferrer">
  Manage Gmail connection
</a>
```

`/connect` accepts a POST from the connector's page; link to `/` as above. The
example does not implement `returnTo` redirects or automatically resume an app
action. These result shapes and routes belong to this example, not to a platform
OAuth protocol.

## Account and storage behavior

The connector identifies a Widefleet caller by `(issuer, subject)` from trusted
entrypoint props, not by an email address or an RPC argument. One Google account
is linked per caller. Other apps granted this same connector reuse that caller's
connection. A Google account cannot simultaneously be linked to a second
Widefleet caller in the same connector. Calls without a verified caller are rejected.

To change Google accounts, disconnect the current one first. **Disconnect**
deletes this user's tokens and short-lived linking sessions locally. It does not
revoke the Google OAuth grant; users can also remove that grant in their Google
account settings. Reconnecting the same account updates its credentials.

The connector's D1 data survives code deployments. Keep its name and D1 binding
stable, and back up the data and secret. `src/database.ts` initializes the example's
schema; if you change that schema after deploying, implement the corresponding
migration in your connector before using the new fields.

For external OAuth clients in Testing mode, Google refresh tokens with Gmail
scopes expire after seven days. Reconnect when needed; see
[Google's token expiration rules](https://developers.google.com/identity/protocols/oauth2#expiration).

## Copy for another provider

Keep the caller mapping, account-linking session, callback checks, D1 storage and
private Better Auth endpoints. Adapt the provider and API surface:

1. Rename the connector in `wrangler.jsonc` and the package in `package.json`.
2. Replace `src/google.ts` with the new provider's ID, authorization/token endpoints,
   scopes and profile mapping. Update client-ID configuration and secret names in
   `src/context.ts`, `src/auth.ts` and `wrangler.jsonc`.
3. Replace the Gmail API methods, response validation and scope check in
   `src/connector.ts`. Update the connection-page labels and cookie prefix.
4. Register the new connector's callback, `/auth/callback/<providerId>`, with that
   provider. Add its credentials and retain a persistent `AUTH_SECRET`.
5. Adapt the synthetic provider tests and run `pnpm typecheck`, `pnpm test` and
   `pnpm build` before deploying.

For GitHub, use its OAuth authorization and token endpoints, map the immutable
GitHub user ID to the profile's `id`, and request scopes appropriate to the API
operations you expose. A GitHub profile can omit its public email; handle that in
your profile lookup instead of assuming Google's email response. GitHub's
[email API](https://docs.github.com/en/rest/users/emails#list-email-addresses-for-the-authenticated-user)
requires `user:email` for OAuth app tokens. Keep the profile
mapping's `providerEmail` field as the display label. Replace Google-specific
offline-access and consent parameters according to
[GitHub's OAuth flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps).
Providers differ in refresh-token behavior and scopes; Generic OAuth handles the
flow, not those provider-specific choices. See
[Better Auth Generic OAuth](https://www.better-auth.com/docs/plugins/generic-oauth).

After adapting and deploying, open the new connector's browser address, connect
a test account and invoke one of its methods from an app granted that connector.
