---
name: OneDrive
description: Find files in your OneDrive and get temporary download links.
---

Connect a personal Microsoft account to list and search OneDrive files and retrieve
temporary download links. Work and school accounts are also supported. Each
signed-in user connects their own account.

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

## Configure Microsoft

An administrator needs to:

1. Register a Microsoft Entra application. Choose **Accounts in any organizational
   directory and personal Microsoft accounts** to support work, school and personal
   accounts.
2. Add `https://YOUR-APP-URL/auth/callback/microsoft` as a **Web** redirect URI and
   add the delegated Microsoft Graph permission `Files.Read`.
3. Create a client secret. Set the app secrets `MICROSOFT_CLIENT_ID`,
   `MICROSOFT_CLIENT_SECRET` and `AUTH_SECRET`. Use the application client ID and
   the client secret's **value**, not its ID. Generate `AUTH_SECRET` randomly with
   at least 32 characters and keep it stable; it encrypts the saved account tokens.
   Use the app's Secrets page or `widefleet secret put NAME --file /path/to/secret`
   to provide values.
4. Allow these backend origins from the app directory:

   ```sh
   widefleet network allow https://login.microsoftonline.com
   widefleet network allow https://graph.microsoft.com
   ```

Network changes require the CLI's `network:manage` scope. Wait for the configuration
to activate, then open the app URL and connect your Microsoft account.

## Use from another app

From the consuming app's directory, an administrator grants a connection:

```sh
widefleet connect onedrive --as ONEDRIVE
```

Replace `onedrive` if you chose another name. Call the service while handling a
signed-in user's request so Widefleet forwards the verified caller identity.

```ts
const result = await env.ONEDRIVE.listFiles();
if (result.status === "connected") {
  const file = result.files.find((item) => item.file);
  if (file) {
    const download = await env.ONEDRIVE.getDownloadUrl(file.id);
    // Check download.status, then let the user open download.url.
  }
}
```

The app exposes `connectionStatus`, `listFiles`, `searchFiles` and `getDownloadUrl`.
See `src/app.ts` for inputs and results. Download URLs grant temporary file access;
open them in the browser and keep them out of logs. The app returns the URL without
fetching the file from Microsoft's download servers.

A `setup_required` result lists missing secrets. `connection_required` and
`reconnect_required` provide a `connectUrl` for the user. `authentication_required`
means the call has no signed-in user. Retry `refresh_failed` after a provider
outage; respect `retryAfter` for `rate_limited`.

After connecting, verify a file listing through the consuming app. Users can
disconnect their account on the OneDrive app's page.
