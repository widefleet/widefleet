---
name: Linear
description: Read teams and issues from a Linear workspace.
---

Connect a personal Linear account to list teams and read issues through Linear's
MCP server. Each signed-in user connects their own account.

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

Keep `pnpm-workspace.yaml` and `patches/` with the source. They patch Better Auth to
sign cookies and encrypt saved account tokens with the app's Widefleet keys, which
the app never reads.

## Configure Linear

Installations with managed OAuth for Linear need no registration: users connect their
accounts directly. Otherwise, an administrator needs to:

1. Create an OAuth application in Linear's API settings. Set its callback URL to
   `https://YOUR-APP-URL/auth/callback/linear`.
2. Set the app secrets `LINEAR_CLIENT_ID` and `LINEAR_CLIENT_SECRET`. Use the app's
   Secrets page or `widefleet secret put NAME --file /path/to/secret` to provide
   values.

In both cases, allow the backend origins that `widefleet.jsonc` declares. A one-click
install from the template page allows them, as does `widefleet catalog templates
install` with the CLI's `network:manage` scope. After `widefleet deploy`, run from
the app directory:

```sh
widefleet network allow https://mcp.linear.app https://api.linear.app
```

Network changes require the CLI's `network:manage` scope. Wait for the configuration
to activate, then open the app URL and connect your Linear account. The connector
requests the `read` scope, so its token cannot change the workspace.

## Use from another app

From the consuming app's directory, an administrator grants a connection:

```sh
widefleet connect linear --as LINEAR
```

Replace `linear` if you chose another name. Call the service while handling a
signed-in user's request so Widefleet forwards the verified caller identity.

```ts
const result = await env.LINEAR.listIssues({ assignee: "me", state: "started" });
if (result.status === "connected") {
  for (const issue of result.issues) console.log(issue.id, issue.title);
}
```

The app exposes `connectionStatus`, `listTeams`, `listIssues` and `getIssue`. See
`src/app.ts` for inputs and results. Pass a result's `cursor` to read the next page.

A `setup_required` result lists missing secrets. `connection_required` and
`reconnect_required` provide a `connectUrl` for the user. `authentication_required`
means the call has no signed-in user. `linear_error` carries Linear's message, for
example for an unknown issue. Retry `refresh_failed` after a provider outage;
respect `retryAfter` for `rate_limited`.

After connecting, verify an issue read through the consuming app. Users can
disconnect their account on the Linear app's page.
