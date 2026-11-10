---
title: Connect external accounts
description: Set up a connector, link your account and use it from an app.
lastModified: 2026-11-10
---

Connectors let your apps use data from accounts you connect. An administrator
configures access to the provider, and each user connects their own account.
When you use a connected app, its requests use your account.

Each connector is a normal app with its own connection page, secrets and data.

## Deploy a connector

Install the [Widefleet CLI](/getting-started/installation) and sign in to the
organization where you want to deploy. You need organization administrator
access to configure the connector.

Copy the complete source directory for
[Gmail](https://github.com/widefleet/widefleet/tree/main/apps/gmail),
[OneDrive](https://github.com/widefleet/widefleet/tree/main/apps/onedrive) or
[GitHub](https://github.com/widefleet/widefleet/tree/main/apps/github) into your
own project directory. Each app can be installed and built independently.
Choose the app's name in `wrangler.jsonc`, then run from that directory:

```sh
pnpm install
pnpm typecheck
pnpm test
widefleet deploy
```

Deployment creates the app and its database. Once it is active, open the app
URL to see the remaining setup steps.

## Configure a connector

You need organization administrator access and permission to register an OAuth
application with the provider. App sign-in and public HTTPS app URLs must be
configured on your installation.

The app's setup page shows the callback URL to register with the provider and
the names of the missing secrets. In the app's **Secrets** tab, set `AUTH_SECRET`
to a cryptographically random value of at least 32 characters. Keep this value
stable: it encrypts the saved account tokens.

Allow the provider's destinations in the app's **Network** tab, or with
`widefleet network allow` from the app project. Then configure its OAuth client
as described below.

### Gmail

Allow `https://accounts.google.com`, `https://oauth2.googleapis.com`,
`https://www.googleapis.com` and `https://gmail.googleapis.com`.

In Google Cloud, enable Gmail API, configure the OAuth consent screen and create
a **Web application** OAuth client. Add the connector's callback URL as an
authorized redirect URI. For example, a connector at
`https://gmail-team.apps.example.com` uses
`https://gmail-team.apps.example.com/auth/callback/google`.

Save the client ID as `GOOGLE_CLIENT_ID` and the client secret as
`GOOGLE_CLIENT_SECRET` in the app's **Secrets** tab.

For an external OAuth application in testing mode, add the accounts that will
connect as test users. Gmail access uses the `gmail.readonly` scope; check
Google's [verification requirements](https://developers.google.com/workspace/gmail/api/auth/scopes)
before making the OAuth application available to a wider audience.

### OneDrive

Allow `https://login.microsoftonline.com` and `https://graph.microsoft.com`.

Register an application in Microsoft Entra supporting the account types your
users will connect. To support both company and personal accounts, choose
**Accounts in any organizational directory and personal Microsoft accounts**.
Add the connector's callback URL as a **Web** redirect URI and add the delegated
Microsoft Graph permission **Files.Read**.

Create a client secret. Save the application client ID as `MICROSOFT_CLIENT_ID`
and the secret's **value**, rather than its ID, as `MICROSOFT_CLIENT_SECRET` in
the app's **Secrets** tab.

### GitHub

Allow `https://github.com` and `https://api.github.com`.

Register a GitHub OAuth app and set its authorization callback URL to the URL
shown by the connector. Save its client ID as `GITHUB_CLIENT_ID` and its client
secret as `GITHUB_CLIENT_SECRET` in the app's **Secrets** tab.

The connector requests the [`repo` scope](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps)
to access private repositories. GitHub grants both read and write access with
this scope. The connector provides methods for listing repositories and issues
and reading files.

### Set secrets with the CLI

You can also save credentials from protected files outside your app project:

```sh
widefleet secret put GOOGLE_CLIENT_ID --app gmail --file /secure/google-client-id
widefleet secret put GOOGLE_CLIENT_SECRET --app gmail --file /secure/google-client-secret
widefleet secret list --app gmail
```

Use the corresponding app and secret names for your provider. Wait for the
secrets to become active, then reload the connector's page.

## Connect your account

Open the connector's app URL and choose **Connect account**. Sign in to the
provider and approve access. The page then shows the connected account.

Each user connects their own account. To switch accounts, choose **Disconnect**
before connecting another one. Disconnecting removes the saved connection from
the connector; you can also revoke the application's access in your provider's
account settings.

## Use the connector from an app

An organization administrator grants the connection in the consuming app's
**Connections** tab. From that app's project, the equivalent CLI command is:

```sh
widefleet connect gmail --as GMAIL
```

See [Connect apps](/guides/app-services) for granting connections and using
bindings. Call the connector from server-side code handling a signed-in user's
request. For example, search Gmail and read the first matching message:

```ts
const result = await env.GMAIL.searchMessages({ query: "has:attachment", maxResults: 10 });
if (result.status === "connected" && result.messages[0]) {
  const message = await env.GMAIL.getMessage(result.messages[0].id);
  if (message.status === "connected") {
    // Use message.message in your app.
  }
}
```

For OneDrive, connect the app as `ONEDRIVE`, list files and request a download
link for a selected file:

```ts
const result = await env.ONEDRIVE.listFiles();
if (result.status === "connected") {
  const file = result.files.find((item) => item.file);
  if (file) {
    const download = await env.ONEDRIVE.getDownloadUrl(file.id);
    if (download.status === "connected") {
      // Let the user open download.url to download the file.
    }
  }
}
```

The OneDrive download URL is temporary and grants access to the file. Request
a new URL when needed instead of saving or logging it.

For GitHub, connect the app as `GITHUB`. Start with
`env.GITHUB.listRepositories()` to list repositories available to the connected
user, then use `readFile({ owner, repository, path })` to read a file.

## When a connection needs attention

Check a result's `status` before using its data. `connection_required`,
`permission_required` and `reconnect_required` include a `connectUrl`; direct the
user there to connect or renew access. For `setup_required`, an administrator
must configure the missing app secrets.

`authentication_required` means the call has no signed-in user. Start the call
from an authenticated app request; scheduled jobs have no personal account context.
For `refresh_failed`, retry before asking the user to reconnect. For
`rate_limited`, wait for the returned `retryAfter` interval when present.

After setup, connect your account and make one read request from a connected app.
A successful result confirms both the app connection and provider access.
