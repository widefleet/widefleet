---
name: Gmail
description: Read, search, send and organize email through the complete Gmail API, with typed results.
secretHelp:
  GOOGLE_CLIENT_ID: >-
    Open your web application in [Google Cloud OAuth clients](https://console.cloud.google.com/auth/clients) and copy its client ID.
  GOOGLE_CLIENT_SECRET: >-
    Use the client secret for the same application in [Google Cloud OAuth clients](https://console.cloud.google.com/auth/clients).
---

Connect a personal Google account and use every method of the Gmail API as a typed
method: messages, threads, drafts, labels, history and settings. Each signed-in user
connects their own account. Changes ask the user first, as each user's approval level
says.

## Deploy

Read the [Widefleet app development guide](https://widefleet.com/docs/guides/app-development)
for CLI setup and authentication. Copy this directory into your project and run:

```sh
pnpm install
pnpm test
widefleet create gmail --name "Gmail"
widefleet secret put GOOGLE_CLIENT_ID --file /path/to/client-id
widefleet secret put GOOGLE_CLIENT_SECRET --file /path/to/client-secret
widefleet deploy
```

Choose the app name in `wrangler.jsonc` and create the app with that name. Its
deployments need the Google OAuth client from [Configure Google](#configure-google), which
`wrangler.jsonc` lists as required secrets. The CLI creates the app's declared
database. Keep your local source for subsequent changes.

Keep `pnpm-workspace.yaml` and `patches/` with the source. They patch Better Auth to
sign cookies and encrypt saved account tokens with the app's Widefleet keys, which
the app never reads.

## Configure Google

An administrator needs to:

1. Create a Google Cloud project, enable the Gmail API and configure the OAuth
   consent screen with the scopes `https://mail.google.com/` and
   `https://www.googleapis.com/auth/gmail.settings.basic`. Google classifies them as
   restricted: an external app needs Google's verification and security assessment
   before people outside its test users can connect. An internal app of a Google
   Workspace organization does not.
2. Create an OAuth client with the **Web application** type. Register
   `https://YOUR-APP-URL/auth/callback/google` as an authorized redirect URI. You can
   add it once the app is installed and its URL is known.
3. Provide the client ID and client secret as the app secrets `GOOGLE_CLIENT_ID` and
   `GOOGLE_CLIENT_SECRET`. Installing from the template page asks for them;
   `widefleet catalog templates install` reads them with
   `--secret-file GOOGLE_CLIENT_ID=/path/to/client-id --secret-file GOOGLE_CLIENT_SECRET=/path/to/client-secret`.
   Change them later on the app's Secrets page or with
   `widefleet secret put NAME --file /path/to/secret`.
4. Allow the backend origins that `widefleet.jsonc` declares. A one-click install
   from the template page allows them, as does `widefleet catalog templates install`
   with the CLI's `network:manage` scope. After `widefleet deploy`, run from the app
   directory:

   ```sh
   widefleet network allow https://accounts.google.com https://oauth2.googleapis.com https://www.googleapis.com https://gmail.googleapis.com
   ```

Network changes require the CLI's `network:manage` scope. Wait for the configuration
to activate, then open the app URL and connect your Google account. The connector
requests full access to Gmail, which every method of the API needs.

## Use from another app

From the consuming app's directory, an administrator grants a connection:

```sh
widefleet connect gmail --as GMAIL
```

Replace `gmail` if you chose another name. Call the service while handling a
signed-in user's request so Widefleet forwards the verified caller identity.

Each method of the Gmail API is a method named after its resource and action, such as
`messagesList`, `messagesGet`, `messagesSend` and `labelsCreate`. `userId` defaults
to `me`. Methods that return data take the fields to return, and the result has
exactly the selected fields:

```ts
const page = await env.GMAIL.messagesList(
  { q: "has:attachment newer_than:7d", maxResults: 10 },
  { messages: { id: true }, nextPageToken: true },
);
if (page.status === "connected") {
  for (const { id } of page.data.messages ?? []) {
    const message = await env.GMAIL.messagesGet(
      { id: id ?? "", format: "metadata", metadataHeaders: ["Subject", "From"] },
      { snippet: true, payload: { headers: { name: true, value: true } } },
    );
  }
}
```

A selection names a field with `true`, or with a nested selection for an object. It
becomes Google's `fields` parameter, so Gmail returns only those fields. Gmail omits
fields it has no value for; they are `undefined` in the result. See `src/api.ts` for
every method, its input and Google's description. Treat email HTML as untrusted
content.

Methods that accept uploads also have a `...WithContent` method, such as
`messagesSendWithContent`, which sends the message as MIME in `content`:
`{ mimeType: "message/rfc822", text }`, or `base64` for bytes. It asks like the method
it extends.

`scripts/operations.ts` lists the methods that are not offered, with the reason:
managing delegates, forwarding addresses, send-as aliases and auto-forwarding needs a
service account with domain-wide delegation.

## Approvals

Reading never asks. Methods that change data ask the user before they run, as their
approval level says:

- `all_changes`: every change asks.
- `updates_and_deletions`, the default: changing, trashing or deleting data and
  sending email ask; creating drafts, labels or filters runs at once.
- `none`: nothing asks.

`scripts/operations.ts` records whether each method creates, updates, deletes or
sends. Users choose their level on the app's page. `approvalLevel` returns the current
level and `setApprovalLevel` changes it: asking more takes effect at once, asking
less asks the user to confirm.

A method that asks returns `input_required` with the method and its input. MCP clients
show the question to the user. A calling app shows it itself and answers with
`withInput`, as described in
[Ask the user before continuing](https://widefleet.com/docs/guides/app-services#ask-the-user-before-continuing).
A declined change returns `declined` and does not run.

## Results

`connected` holds the selected `data`, or `null` for methods without a result.
`gmail_error` carries Google's message, HTTP status, status and reasons, for example
for an unknown message. A `setup_required` result lists missing secrets.
`connection_required` and `reconnect_required` provide a `connectUrl` for the user;
`permission_required` means the account granted fewer scopes than the connector needs
and must reconnect. `authentication_required` means the call has no signed-in user.
Retry `refresh_failed` after a provider outage; respect `retryAfter` for
`rate_limited`. `too_large` means the response is larger than `maximumBytes` (8 MiB):
select fewer fields, or read a large attachment in a calling app. A selection or input
that does not match the method fails before anything is sent.

After connecting, verify a message search through the consuming app. Users can disconnect
their account on the Gmail app's page.

## Update the API

`src/api.ts` and `src/schema.ts` are generated from Google's Discovery document for
the Gmail API by the template generator in the Widefleet repository. To pick up
Google's changes in your app, run from a checkout of that repository with your app's
directory:

```sh
pnpm --filter @platform/template-generator generate /path/to/your/app
```

The generator reads your app's `scripts/operations.ts` and rewrites `src/api.ts`,
`src/schema.ts` and the shared files it copies into `src`, such as `src/google.ts`
and `src/approval.ts`. Keep your own changes out of these files. The generator stops
when Google adds a method that changes data and `scripts/operations.ts` does not list
yet: add it with the kind of change it makes, or with the reason it is not offered.
Review the diff before deploying.
