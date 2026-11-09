---
title: Gmail, OneDrive and GitHub
description: Configure the standard apps and connect personal provider accounts.
lastModified: 2026-11-09
---

Widefleet creates Gmail, OneDrive and GitHub as ordinary apps in each organization.
An administrator supplies the provider's OAuth client credentials; each user then
connects their personal account on the app's own page. Other apps use these APIs
through [app connections](/guides/app-services).

You need organization administrator access, a signed-in CLI matching the installation's
release, and a public HTTPS address for your apps. Organization sign-in must work
before you connect a provider account.

## Configure an app

Open **Apps**, wait for the provider app's deployment to become active, and open
its browser URL. The connection page shows missing secret names and the exact
callback URL to register with the provider.

| App        | Client secrets                                   | Callback path              |
| ---------- | ------------------------------------------------ | -------------------------- |
| `gmail`    | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`       | `/auth/callback/google`    |
| `onedrive` | `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` | `/auth/callback/microsoft` |
| `github`   | `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`       | `/auth/callback/github`    |

Register the callback at the app's HTTPS origin. For example, a Gmail app at
`https://gmail-team.apps.example.com/` uses
`https://gmail-team.apps.example.com/auth/callback/google`.

- **Google:** enable Gmail API, configure the consent screen, and create a Web
  application OAuth client. Add your users as test users when using Google's
  external testing mode. The app requests profile, email and `gmail.readonly`.
  Review Google's [restricted-scope requirements](https://developers.google.com/workspace/gmail/api/auth/scopes)
  for your audience and data use.
- **Microsoft:** register an application supporting organizational and personal
  Microsoft accounts, add the callback as a Web redirect URI, and create a client
  secret. Add delegated Microsoft Graph `Files.Read` permission. The app uses the
  `common` tenant endpoint and requests sign-in and offline access as well.
- **GitHub:** register an OAuth app with the callback above. The `repo` scope used
  to access private repositories also grants write permissions at GitHub, although
  this app exposes only read methods. See GitHub's [scope reference](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps).

Save the two values under the app's **Secrets** tab. Alternatively, put each value
in a protected file outside the project and run:

```sh
widefleet secret put GOOGLE_CLIENT_ID --app gmail --file /secure/google-client-id
widefleet secret put GOOGLE_CLIENT_SECRET --app gmail --file /secure/google-client-secret
widefleet secret list --app gmail
```

Use the corresponding names and app slug for Microsoft or GitHub. Wait for secret
activation before connecting. Widefleet already supplies a separate random
`AUTH_SECRET` and the provider's backend network permissions for each app.

The app's D1 database contains encrypted account tokens. Preserve its data and
`AUTH_SECRET` together. Replacing that secret makes existing tokens unreadable;
users must disconnect and reconnect. Changing the provider OAuth client may also
require reconnection.

## Connect a personal account

Open the provider app, sign in to Widefleet, and choose **Connect**. Complete the
provider's authorization flow. The connection page then shows the linked account.

Each user can connect one account per provider app. Choose **Disconnect** before
switching accounts. An external account can belong to one Widefleet user in that
app at a time. Disconnecting deletes the saved tokens and linking sessions; revoke
the provider grant in the provider's account settings when that is also needed.

An administrator connects a consuming app through its **Connections** tab or the CLI:

```sh
widefleet connect gmail --as GMAIL --app inbox
widefleet connect onedrive --as ONEDRIVE --app inbox
widefleet connect github --as GITHUB --app inbox
widefleet connections --app inbox
```

The default entrypoint exposes the methods below. The current signed-in user's
verified identity selects their connected account, including across app-to-app
calls. A cron, queue or workflow invocation without a signed-in user returns
`authentication_required`.

## Discover and call methods

Run `widefleet services`, request `GET /api/v1/app-services`, or open **Services**
to inspect each deployed app's method descriptions, parameter and return types,
and examples. These descriptions come from TypeScript and TSDoc during the build.

| App      | Methods                                                                                     |
| -------- | ------------------------------------------------------------------------------------------- |
| Gmail    | `connectionStatus()`, `searchMessages(input?)`, `getMessage(id)`, `getAttachment(id, part)` |
| OneDrive | `connectionStatus()`, `listFiles(input?)`, `searchFiles(input)`, `getDownloadUrl(id)`       |
| GitHub   | `connectionStatus()`, `listRepositories(input?)`, `listIssues(input)`, `readFile(input)`    |

For example, server-side code in the connected app can search Gmail:

```ts
const result = await env.GMAIL.searchMessages({ query: "has:attachment", maxResults: 10 });
if (result.status === "connected") {
  for (const message of result.messages) {
    const content = await env.GMAIL.getMessage(message.id);
    // Handle content.status before using content.message.
  }
}
```

Gmail search results contain IDs. `getMessage` returns headers, text, HTML and
attachment descriptors; treat HTML as untrusted email content. `getAttachment`
returns bytes and base64url, with an 8 MiB limit. GitHub `readFile` also returns
bytes up to 8 MiB. Follow the returned pagination token or page number to continue;
GitHub issue pages can be empty when they contain only pull requests.

OneDrive lists and searches the user's drive. Pass a result's `nextPageUrl` as
`pageUrl` with the same folder or query. `getDownloadUrl` returns a temporary URL
for direct browser download. Microsoft [redirects file downloads](https://learn.microsoft.com/en-us/graph/api/driveitem-get-content?view=graph-rest-1.0)
to varying file hosts, so the connector does not fetch the content itself. The URL
grants access to the file: do not log or persist it, and request another when it
expires. Open links with `rel="noreferrer"`.

## Handle setup and provider errors

`connectionStatus()` reports the saved link without checking token validity.
Methods return a `status` when setup, user action or a retry is needed:

| Status                                                             | Action                                                                            |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| `setup_required`                                                   | Configure the listed `missing` secrets, then wait for activation.                 |
| `authentication_required`                                          | Start from a signed-in app request.                                               |
| `connection_required`, `permission_required`, `reconnect_required` | Open the returned `connectUrl` so the user can connect or renew authorization.    |
| `refresh_failed`                                                   | Retry; an upstream outage may prevent refresh. Reconnect if the problem persists. |
| `access_denied`                                                    | Check provider permissions and organization policies.                             |
| `not_found`                                                        | Check the resource ID and the connected account's access.                         |
| `rate_limited`                                                     | Retry later, observing `retryAfter` when present.                                 |
| `too_large`                                                        | Use a smaller file or retrieve it through the provider.                           |

Other provider failures and invalid arguments reject the RPC call. Use ordinary
[app logs](/guides/deployments) and deployment history to investigate.

## Existing organizations and customization

New organizations receive the apps during setup. Existing self-hosted organizations
receive them when the control plane starts; hosted installations provision them
in bounded hourly maintenance batches. A conflicting app slug is left alone.

The standard apps use normal deployments, networking, secrets and D1 resources.
Renaming or deleting an app is preserved. Widefleet does not overwrite installed
app code or automatically upgrade it. The standalone [Gmail example](/guides/gmail-app)
is also available for a separate app you maintain yourself.

After configuring a provider, connect your own account and call `connectionStatus()`
from a connected app. A `connected` response confirms the saved link; test one read
method to confirm the provider permissions too.
