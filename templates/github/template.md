---
name: GitHub
description: Read and change repositories, issues, pull requests and projects through GitHub's GraphQL API, with typed results.
---

Connect a personal GitHub account and use GitHub's GraphQL API as typed methods:
repositories, issues, pull requests, reviews, discussions, projects, commits and
more. Each signed-in user connects their own account. Changes ask the user first,
as each user's approval level says.

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

## Configure GitHub

Installations with managed OAuth for GitHub need no registration: users connect
their accounts directly. Otherwise, an administrator needs to:

1. Register a GitHub OAuth app. Set its authorization callback URL to
   `https://YOUR-APP-URL/auth/callback/github`.
2. Set the app secrets `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`. Use the app's
   Secrets page or `widefleet secret put NAME --file /path/to/secret` to provide
   values.

In both cases, allow the backend origins that `widefleet.jsonc` declares. A one-click
install from the template page allows them, as does `widefleet catalog templates
install` with the CLI's `network:manage` scope. After `widefleet deploy`, run from
the app directory:

```sh
widefleet network allow https://github.com https://api.github.com
```

Network changes require the CLI's `network:manage` scope. Wait for the configuration
to activate, then open the app URL and connect your GitHub account.

The connector requests the scopes the offered methods need: `repo` for repositories,
issues and pull requests, `workflow` for commits that change workflow files,
`project` for Projects, `read:org` for organizations and teams, and `user` for the
user's status and follows. An account connected with fewer scopes is asked to
reconnect. GitHub organizations may require approval for the OAuth app, and
organizations with SAML single sign-on require the user to authorize the token for
them, before their repositories become available.

## Use from another app

From the consuming app's directory, an administrator grants a connection:

```sh
widefleet connect github --as GITHUB
```

Replace `github` if you chose another name. Call the service while handling a
signed-in user's request so Widefleet forwards the verified caller identity.

Each query and mutation is a method with the same name. Methods that return objects
take the fields to return, and the result has exactly the selected fields:

```ts
const result = await env.GITHUB.repository(
  { owner: "example", name: "project" },
  {
    issues: {
      $args: { first: 10, states: ["OPEN"] },
      nodes: { number: true, title: true, author: { login: true } },
    },
  },
);
if (result.status === "connected" && result.data) {
  for (const issue of result.data.issues.nodes ?? []) console.log(issue?.number, issue?.title);
}
```

A selection names a field with `true`, or with a nested selection for a related
object. `$args` passes a field's arguments, such as
`{ pullRequests: { $args: { first: 5 }, nodes: { title: true } } }`. For a field
that returns one of several types, such as `node` or `search`, `$on` selects fields
per type and the result carries `__typename`. Most data is reached through
`repository`, `viewer`, `organization`, `user`, `node` and `search`. File contents
are `Blob` objects: `repository.object` with `$args: { expression: "main:README.md" }`
and `$on: { Blob: { text: true } }` reads a text file. See `src/api.ts` for every
method, its input and GitHub's description.

`scripts/operations.ts` lists the operations that are not offered, such as
enterprise administration, organization settings and GitHub Sponsors, with the
reason for each.

## Approvals

Queries never ask. Mutations ask the user before they run, as their approval level
says:

- `all_changes`: every mutation asks.
- `updates_and_deletions`, the default: mutations that change, merge, close,
  restrict or delete existing data ask; mutations that only add data, such as an
  issue, a comment or a branch, run at once.
- `none`: no mutation asks.

`scripts/operations.ts` records whether each mutation creates, updates, deletes or sends.
Users choose their level on the app's page. `approvalLevel` returns the current level
and `setApprovalLevel` changes it: asking more takes effect at once, asking less asks
the user to confirm.

A mutation that asks returns `input_required` with the mutation and its input. MCP
clients show the question to the user. A calling app shows it itself and answers with
`withInput`, as described in
[Ask the user before continuing](https://widefleet.com/docs/guides/app-services#ask-the-user-before-continuing).
A declined change returns `declined` and does not run.

## Results

`connected` holds the selected `data`. `github_error` carries GitHub's `errors` with
their `type`, for example `NOT_FOUND` for an unknown repository or `FORBIDDEN` for
missing access. A `setup_required` result lists missing secrets.
`connection_required`, `reconnect_required` and `permission_required` provide a
`connectUrl` for the user. `authentication_required` means the call has no signed-in
user. `access_denied` means GitHub refused the request. Retry `refresh_failed` after
a provider outage; respect `retryAfter` for `rate_limited`. A selection or input that
does not match GitHub's schema fails before anything is sent.

After connecting, verify a repository read through the consuming app. Users can
disconnect their account on the GitHub app's page.

## Update the API

`src/api.ts` and `src/schema.ts` are generated from GitHub's published GraphQL schema
by the template generator in the Widefleet repository. To pick up GitHub's changes in
your app, run from a checkout of that repository with your app's directory:

```sh
pnpm --filter @platform/template-generator generate /path/to/your/app
```

The generator reads your app's `scripts/operations.ts` and rewrites `src/api.ts`,
`src/schema.ts` and the shared files it copies into `src`, such as `src/graphql.ts`
and `src/approval.ts`. Keep your own changes out of these files. The generator stops
when GitHub adds a mutation that `scripts/operations.ts` does not list yet: add it
with the kind of change it makes, or with the reason it is not offered. Review the
diff before deploying.
