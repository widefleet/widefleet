---
name: Gmail
description: Search and read email and download attachments from your Gmail account.
---

Connect a personal Google account to search messages, read their contents and
retrieve attachments. Each signed-in user connects their own account.

## Deploy

Read the [Widefleet app development guide](https://widefleet.com/docs/guides/app-development)
for CLI setup and authentication. Copy this directory into your project and run:

```sh
pnpm install
pnpm test
widefleet deploy
```

Choose the app name in `wrangler.jsonc` before deploying. The CLI creates the app
and its declared database. Keep your local source for subsequent changes.

## Configure Google

An administrator needs to:

1. Create a Google Cloud project, enable the Gmail API and configure the OAuth
   consent screen. For an external app in testing mode, add the Google accounts
   that will connect as test users.
2. Create an OAuth client with the **Web application** type. Register
   `https://YOUR-APP-URL/auth/callback/google` as an authorized redirect URI.
3. Set the app secrets `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `AUTH_SECRET`.
   Generate `AUTH_SECRET` randomly with at least 32 characters and keep it stable;
   it encrypts the saved account tokens. Use the app's Secrets page or
   `widefleet secret put NAME --file /path/to/secret` to provide values.
4. Allow these backend origins from the app directory:

   ```sh
   widefleet network allow https://accounts.google.com
   widefleet network allow https://oauth2.googleapis.com
   widefleet network allow https://www.googleapis.com
   widefleet network allow https://gmail.googleapis.com
   ```

Network changes require the CLI's `network:manage` scope. Wait for the configuration
to activate, then open the app URL and connect your Google account. The requested
`gmail.readonly` scope permits reading mail.

## Use from another app

From the consuming app's directory, an administrator grants a connection:

```sh
widefleet connect gmail --as GMAIL
```

Replace `gmail` if you chose another name. Call the service while handling a
signed-in user's request so Widefleet forwards the verified caller identity.

```ts
const result = await env.GMAIL.searchMessages({ query: "has:attachment", maxResults: 10 });
if (result.status === "connected" && result.messages[0]) {
  const message = await env.GMAIL.getMessage(result.messages[0].id);
  // Check message.status before using the message.
}
```

The app exposes `connectionStatus`, `searchMessages`, `getMessage` and
`getAttachment`. See `src/app.ts` for inputs and results. Messages and attachments
have an 8 MiB read limit. Treat email HTML as untrusted content.

A `setup_required` result lists missing secrets. `connection_required`,
`permission_required` and `reconnect_required` provide a `connectUrl` for the user.
`authentication_required` means the call has no signed-in user. Retry
`refresh_failed` after a provider outage; respect `retryAfter` for `rate_limited`.

After connecting, verify a search through the consuming app. Users can disconnect
their account on the Gmail app's page.
