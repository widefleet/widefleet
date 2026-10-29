---
title: Gmail app example
description: Copy an app that links personal Google accounts with Better Auth and D1.
lastModified: 2026-10-29
---

Deploy the [Gmail example](https://github.com/widefleet/widefleet/tree/v0.5.0/examples/apps/gmail)
to let users connect their own Google accounts and read Gmail from your apps.
It includes a connection page and persistent account storage; apps access Gmail
through an app service binding. The runtime carries the verified company identity
from the calling app; Gmail never accepts a user ID supplied as an RPC argument.

## Prerequisites

- An organization administrator account and a signed-in Widefleet CLI.
- Matching control-plane, CLI, deployment-agent and app-runtime releases at
  **0.5.0 or newer** for
  [app services and verified callers](/guides/app-services#user-identity).
  Configure organization sign-in and a public HTTPS app address first.
- Node.js 24 or newer and pnpm 12.4.2 for the app project.
- A Google Cloud project where you can enable Gmail API and create an OAuth client.

## Copy and deploy

Copy the complete example directory, including its lockfile and package-manager
configuration, into your own repository:

```sh
git clone --depth 1 --branch v0.5.0 https://github.com/widefleet/widefleet.git
cp -R widefleet/examples/apps/gmail gmail-app
cd gmail-app
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
```

In Google Cloud, enable **Gmail API**, configure the OAuth consent screen and create
a **Web application** OAuth client. For an external application in Testing mode,
add your intended Google accounts as test users. Set `GOOGLE_CLIENT_ID` in
`wrangler.jsonc` to that client's ID, then deploy:

```sh
widefleet deploy --skip-build
widefleet apps
```

Wait for the app's activation to succeed. Open Gmail from **Apps** and copy its HTTPS URL.
The app's callback path is `/auth/callback/google`. For example, an
app URL of `https://gmail-team.apps.example.com/` requires this exact
**Authorized redirect URI** in your Google OAuth client:

```text
https://gmail-team.apps.example.com/auth/callback/google
```

The same callback serves all apps connected to Gmail.

Allow the Google endpoints from the Gmail app's backend network policy. Sign in
with `network:manage` in addition to the deployment scopes:

```sh
widefleet login --scope platform:read platform:write network:manage
widefleet network allow https://oauth2.googleapis.com https://www.googleapis.com https://gmail.googleapis.com --app gmail
```

The OAuth page navigates to Google; it needs no browser network grant. Set these
secrets in **Apps → gmail → Secrets**:

| Secret                 | Value                                                                                                                      |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `GOOGLE_CLIENT_SECRET` | The secret of the Google OAuth client above.                                                                               |
| `AUTH_SECRET`          | A persistent random secret of at least 32 characters, generated with a password manager or cryptographic random generator. |

Alternatively, put each value in a protected file outside the project and use:

```sh
widefleet secret put GOOGLE_CLIENT_SECRET --app gmail --file /absolute/path/to/google-client-secret.txt
widefleet secret put AUTH_SECRET --app gmail --file /absolute/path/to/auth-secret.txt
```

Back up `AUTH_SECRET` with the app's D1 data: it encrypts saved tokens,
and replacing it requires users to reconnect. Deployment provisions D1; the
app initializes its tables on first use.

The requested scopes are Google profile, email and `gmail.readonly`.
Google classifies `gmail.readonly` as a restricted scope. Check the
[Google verification requirements](https://developers.google.com/workspace/gmail/api/auth/scopes)
for your application's audience and data use before distributing it beyond testing.

## Connect a user and an app

Open the Gmail app URL, sign in through the organization's identity provider, then choose
**Connect Google account**. Select a Google account and approve the requested
permissions. The callback returns to the app page, which displays the linked
email address. Return to your app and retry its Gmail action.

Give an existing app the binding:

```sh
widefleet connect gmail --as GMAIL --app inbox
```

The app's server code can call:

```ts
const result = await env.GMAIL.listMessages({ maxResults: 20 });
```

Use these app methods:

| Method                                      | Result                                                                                                                                                         |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `connectionStatus()`                        | `{ connected, googleAccountId }` describing the saved link; it does not check token validity with Google.                                                      |
| `listMessages({ maxResults?, pageToken? })` | On success, `{ status: "connected", messages, nextPageToken? }`. Each message has `id` and `threadId`. The default page size is 20; the example permits 1–100. |
| `getMessage(id)`                            | On success, `{ status: "connected", message }` with the message ID, thread ID, snippet and headers. It requests metadata, not the full message body.           |

The Gmail methods return a status when user action or a retry is needed:

| Status                | App behavior                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------- |
| `connection_required` | Show the connection link.                                                                         |
| `permission_required` | Ask the user to reconnect and grant Gmail access.                                                 |
| `refresh_failed`      | Offer a retry and a reconnection link; the failure may be temporary.                              |
| `reconnect_required`  | Google rejected the access token with HTTP 401; offer reconnection.                               |
| `access_denied`       | Google returned HTTP 403. Check granted scopes, Gmail API enablement and Google Workspace policy. |

Other errors, including rate limits and provider outages during a Gmail API call,
reject the RPC call. Apply the app's usual error handling. Never render message
snippets or header values as unescaped HTML.

The app can open the app page in another tab so its own state remains available:

```html
<a href="https://gmail-team.apps.example.com/" target="_blank" rel="noopener noreferrer">
  Manage Gmail connection
</a>
```

Use the deployed Gmail app URL to open the connection page; its buttons submit the connection and
disconnection requests. After connecting, the user returns to the app and retries
the Gmail action.

## Manage connections

Each signed-in user links one Google account, shared across apps using this
app. To switch accounts, choose **Disconnect** first. A Google account can
belong to one Widefleet user in this app at a time.

**Disconnect** removes the saved tokens and linking sessions. To revoke the
provider grant as well, remove the connection in your Google account settings.
Reconnecting the same account updates its credentials.

D1 data survives deployments. Keep the app name and D1 binding stable, and
back up the data together with `AUTH_SECRET`. If you customize the database
schema, include a migration for existing data.

For testing and public distribution, review Google's
[scope verification requirements](https://developers.google.com/workspace/gmail/api/auth/scopes)
and [token expiration rules](https://developers.google.com/identity/protocols/oauth2#expiration).

## Adapt to another provider

Keep the caller identity and account-linking checks. Replace the provider
configuration in `src/google.ts`, the credentials in `wrangler.jsonc` and
`src/context.ts`, and the API methods in `src/app.ts`. Update the page labels,
cookie prefix and tests for your provider.

Register `/auth/callback/<providerId>` at the new app origin, add its
credentials, and run `pnpm typecheck`, `pnpm test` and `pnpm build`. Check your
provider's scopes, profile fields and refresh-token behavior; see
[Better Auth Generic OAuth](https://www.better-auth.com/docs/plugins/generic-oauth).

Deploy the adapted app, connect a test account at its browser address, and
call a method from an app bound to it.
