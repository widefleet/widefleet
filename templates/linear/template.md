---
name: Linear
description: Read and change a Linear workspace through Linear's complete GraphQL API, with typed results.
---

Connect a personal Linear account and use every query and mutation of Linear's
GraphQL API as a typed method: issues, projects, cycles, comments, documents,
initiatives and more. Each signed-in user connects their own account. Changes ask
the user first, as each user's approval level says.

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

In both cases, allow the backend origin that `widefleet.jsonc` declares. A one-click
install from the template page allows it, as does `widefleet catalog templates
install` with the CLI's `network:manage` scope. After `widefleet deploy`, run from
the app directory:

```sh
widefleet network allow https://api.linear.app
```

Network changes require the CLI's `network:manage` scope. Wait for the configuration
to activate, then open the app URL and connect your Linear account. The connector
requests the `read` and `write` scopes.

## Use from another app

From the consuming app's directory, an administrator grants a connection:

```sh
widefleet connect linear --as LINEAR
```

Replace `linear` if you chose another name. Call the service while handling a
signed-in user's request so Widefleet forwards the verified caller identity.

Each query and mutation is a method with the same name. Methods that return objects
take the fields to return, and the result has exactly the selected fields:

```ts
const result = await env.LINEAR.issues(
  { first: 10, filter: { assignee: { isMe: { eq: true } } } },
  { nodes: { identifier: true, title: true, state: { name: true } } },
);
if (result.status === "connected") {
  for (const issue of result.data.nodes) console.log(issue.identifier, issue.state.name);
}
```

A selection names a field with `true`, or with a nested selection for a related
object. `$args` passes a field's arguments, such as
`{ comments: { $args: { first: 5 }, nodes: { body: true } } }`. For a field that
returns one of several types, `$on` selects fields per type and the result carries
`__typename`. See `src/api.ts` for every method, its input and Linear's description.

The queries `initiativeUpdate` and `projectUpdate`, which read one status update,
are `initiativeUpdateById` and `projectUpdateById`: the mutations of the same name
update an initiative or project. `scripts/operations.ts` lists the operations that
are not offered, such as Linear's own sign-in flows, with the reason for each.

## Approvals

Queries never ask. Mutations ask the user before they run, as their approval level
says:

- `all_changes`: every mutation asks.
- `updates_and_deletions`, the default: mutations that change, archive or delete
  existing data ask; mutations that only create data run at once.
- `none`: no mutation asks.

`scripts/operations.ts` records whether each mutation creates, updates or deletes.
Users choose their level on the app's page. `approvalLevel` returns the current level
and `setApprovalLevel` changes it: asking more takes effect at once, asking less asks
the user to confirm.

A mutation that asks returns `input_required` with the mutation and its input. MCP
clients show the question to the user. A calling app shows it itself and answers with
`withInput`, as described in
[Ask the user before continuing](https://widefleet.com/docs/guides/app-services#ask-the-user-before-continuing).
A declined change returns `declined` and does not run.

## Results

`connected` holds the selected `data`. `linear_error` carries Linear's `errors`, for
example for an unknown issue or invalid input. A `setup_required` result lists
missing secrets. `connection_required` and `reconnect_required` provide a
`connectUrl` for the user. `authentication_required` means the call has no signed-in
user. Retry `refresh_failed` after a provider outage; respect `retryAfter` for
`rate_limited`. A selection or input that does not match Linear's schema fails
before anything is sent.

After connecting, verify an issue read through the consuming app. Users can
disconnect their account on the Linear app's page.

## Update the API

`src/api.ts` and `src/schema.ts` are generated from Linear's published GraphQL schema.
To pick up Linear's changes, run:

```sh
pnpm generate
```

The script stops when Linear adds a mutation that `scripts/operations.ts` does not
list yet: add it with the kind of change it makes, or with the reason it is not
offered. Review the diff before deploying.
