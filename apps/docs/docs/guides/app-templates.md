---
title: Use an app template
description: Install a ready-made app, connect accounts and use it from agents and other apps.
lastModified: 2026-11-26
---

App templates are ready-made apps for the tools your team already uses, such as
Gmail, GitHub, Linear or Outlook. Install one into your organization, connect your
account and use it from your agents and apps.

Sign in to the organization where you want the app. Installing needs permission to
create apps in it.

## Install from the catalog

1. Open **App catalog → Templates** in the control plane.
2. Choose a template and read its setup steps.
3. Enter any required secrets, such as an OAuth client ID, and select **Install**.

The template page lists the external services the app connects to. Installing
allows them and deploys the app. Choose **Open** to go to the installed app.

To let your agent do the setup, copy the prompt under **Set up with your agent**
and paste it into your agent. It installs the template with the CLI, reuses a
suitable existing app and guides you through the remaining steps.

## Install from the CLI

```sh
widefleet catalog templates list --search mail
widefleet catalog templates show gmail
widefleet catalog templates install gmail \
  --secret-file GOOGLE_CLIENT_ID=./client-id \
  --secret-file GOOGLE_CLIENT_SECRET=./client-secret
```

`show` returns the template's setup steps and the secrets it requires in
`requiredSecrets`. `install` saves each secret from its file, deploys the app and
prints the app as JSON. Use `--name` to install a template a second time under
another name. If your login cannot change network permissions, the CLI prints the
`widefleet network allow` command an administrator runs to finish the setup.

Use `--organization ID` when you work across organizations. See
[organization selection](/reference/cli-configuration#select-an-organization).

## Connect your account

Open the app's URL and connect your account with the service. Each person
connects their own account, so the app acts with that person's permissions.
Disconnect on the same page at any time.

When the service asks for more permissions than an account granted, the app asks
the person to connect again.

## Use from agents and apps

Agents in [MCP clients](/guides/mcp) find the app's methods through Widefleet and
call them for the signed-in person. Ask for what you need, such as "Show my
unread emails from today".

To use the app from your own app, connect it from the calling app's directory:

```sh
widefleet connect gmail --as GMAIL
```

Call the binding while handling a signed-in person's request. Widefleet forwards
their identity, and the template uses their connected account. Each method follows
the service's API. Methods of GraphQL and Google APIs take the fields to return,
and the result contains exactly those fields:

```ts
const page = await env.GMAIL.messagesList(
  { q: "is:unread newer_than:1d", maxResults: 10 },
  { messages: { id: true, threadId: true }, nextPageToken: true },
);

if (page.status === "connected") {
  for (const message of page.data.messages ?? []) console.log(message.id);
}
```

A selection names a field with `true`, or with a nested selection for an object.
In GraphQL APIs, `$args` passes a field's arguments, such as
`{ comments: { $args: { first: 5 }, nodes: { body: true } } }`, and `$on` selects
fields per type. Fields the service has no value for are `undefined`.

**App APIs** in the control plane documents every method, its input and the
service's description. See [Connect apps](/guides/app-services) for connection
permissions.

### Results

Every method returns a `status`:

| Status                                         | Meaning                                                              |
| ---------------------------------------------- | -------------------------------------------------------------------- |
| `connected`                                    | `data` holds the result.                                             |
| `connection_required`, `reconnect_required`    | The person connects or reconnects their account at `connectUrl`.     |
| `permission_required`                          | The account granted fewer permissions than the app needs; reconnect. |
| `setup_required`                               | The app is missing the secrets listed in the result.                 |
| `authentication_required`                      | The call has no signed-in person.                                    |
| `rate_limited`                                 | Retry after `retryAfter`, as the service sent it.                    |
| `refresh_failed`                               | The service was unavailable while renewing access; retry later.      |
| `too_large`                                    | The response exceeds 8 MiB; select fewer fields or items.            |
| `declined`                                     | The person declined the change; nothing ran.                         |
| an error of the service, such as `gmail_error` | The service's own error message and details.                         |

Inputs and selections are checked against the service's schema before anything
is sent.

## Approve changes

Reading never asks. Methods that change data ask the person first, according to
their approval level on the app's page:

- **Ask before every change**
- **Ask before changing, deleting or sending** (default): creating new items,
  such as a draft or a label, runs at once.
- **Never ask**

A method that asks returns `input_required`. MCP clients show the question to the
person. A calling app shows it itself and answers with `withInput`, as described
in [Ask the user before continuing](/guides/app-services#ask-the-user-before-continuing).

## Customize a template

Open **View source** on the template page and copy the template's directory into
your project. Keep `pnpm-workspace.yaml` and `patches/` with the source.

To change an installed template app, set `name` in `wrangler.jsonc` to the app's
name and deploy. The app keeps its secrets and connected accounts:

```sh
pnpm install
pnpm test
widefleet deploy
```

To deploy the source as a new app, create it and save the secrets the template
requires first, such as for Gmail:

```sh
widefleet create my-gmail --name "My Gmail"
widefleet secret put GOOGLE_CLIENT_ID --file ./client-id
widefleet secret put GOOGLE_CLIENT_SECRET --file ./client-secret
widefleet deploy
```

Set the same name in `wrangler.jsonc`. See [saving and recovering source code](/guides/source-code)
to continue from another session or machine.

Template methods are generated from the service's published API description. To
pick up the service's latest API, run the generator from a checkout of the
[Widefleet repository](https://github.com/widefleet/widefleet) with your app's
directory:

```sh
pnpm --filter @platform/template-generator generate /path/to/your/app
```

`scripts/operations.ts` lists the offered operations and whether each one
creates, updates, deletes or sends. The generator rewrites `src/api.ts`,
`src/schema.ts` and the shared runtime files, so keep your own code in other
files. When the service adds an operation that changes data, add it to
`scripts/operations.ts`. Review the diff before deploying.

## Create an app for another use case

Open **App not here? Create one with your agent** below the templates. Copy the
prompt and describe what you need. Your agent can also read this prompt from
`widefleet catalog templates list` as `createPrompt`.

The [app development guide](/guides/app-development) covers building and
deploying your own app.
