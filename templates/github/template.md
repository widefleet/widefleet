---
name: GitHub
description: Read repositories, issues and files, including private repositories.
---

Connect a personal GitHub account to list repositories and issues and read files.
Each signed-in user connects their own account.

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

## Configure GitHub

An administrator needs to:

1. Register a GitHub OAuth app. Set its authorization callback URL to
   `https://YOUR-APP-URL/auth/callback/github`.
2. Set the app secrets `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` and `AUTH_SECRET`.
   Generate `AUTH_SECRET` randomly with at least 32 characters and keep it stable;
   it encrypts the saved account tokens. Use the app's Secrets page or
   `widefleet secret put NAME --file /path/to/secret` to provide values.
3. Allow these backend origins from the app directory:

   ```sh
   widefleet network allow https://github.com
   widefleet network allow https://api.github.com
   ```

Network changes require the CLI's `network:manage` scope. Wait for the configuration
to activate, then open the app URL and connect your GitHub account. Private
repositories require the `repo` scope, which also grants write access; the supplied
app exposes read methods. GitHub organizations may require approval for the OAuth
app before their repositories become available.

## Use from another app

From the consuming app's directory, an administrator grants a connection:

```sh
widefleet connect github --as GITHUB
```

Replace `github` if you chose another name. Call the service while handling a
signed-in user's request so Widefleet forwards the verified caller identity.

```ts
const result = await env.GITHUB.readFile({
  owner: "example",
  repository: "project",
  path: "README.md",
});
if (result.status === "connected") {
  const text = new TextDecoder().decode(result.data);
}
```

The app exposes `connectionStatus`, `listRepositories`, `listIssues` and `readFile`.
See `src/app.ts` for inputs and results. File reads have an 8 MiB limit.

A `setup_required` result lists missing secrets. `connection_required` and
`reconnect_required` provide a `connectUrl` for the user. `authentication_required`
means the call has no signed-in user. Retry `refresh_failed` after a provider
outage; respect `retryAfter` for `rate_limited`.

After connecting, verify a repository read through the consuming app. Users can
disconnect their account on the GitHub app's page.
