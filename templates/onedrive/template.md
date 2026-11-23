---
name: OneDrive
description: Browse, search, upload, move and share OneDrive files through Microsoft Graph, with typed results.
---

Connect a personal Microsoft account and use OneDrive's operations of Microsoft
Graph as typed methods: drives, folders and files, search, content, versions,
sharing and following. Work, school and personal accounts are supported. Each
signed-in user connects their own account. Changes ask the user first, as each
user's approval level says.

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

## Configure Microsoft

Installations with managed OAuth for Microsoft need no registration: users connect
their accounts directly. Otherwise, an administrator needs to:

1. Register a Microsoft Entra application. Choose **Accounts in any organizational
   directory and personal Microsoft accounts** to support work, school and personal
   accounts.
2. Add `https://YOUR-APP-URL/auth/callback/microsoft` as a **Web** redirect URI and
   add the delegated Microsoft Graph permission `Files.ReadWrite.All`.
3. Create a client secret. Set the app secrets `MICROSOFT_CLIENT_ID` and
   `MICROSOFT_CLIENT_SECRET`. Use the application client ID and the client secret's
   **value**, not its ID. Use the app's Secrets page or
   `widefleet secret put NAME --file /path/to/secret` to provide values.

In both cases, allow the backend origins that `widefleet.jsonc` declares. A one-click
install from the template page allows them, as does `widefleet catalog templates
install` with the CLI's `network:manage` scope. After `widefleet deploy`, run from
the app directory:

```sh
widefleet network allow https://login.microsoftonline.com https://graph.microsoft.com
```

Network changes require the CLI's `network:manage` scope. Wait for the configuration
to activate, then open the app URL and connect your Microsoft account.

The connector requests `Files.ReadWrite.All`, which covers the user's own files and
the files others share with them. An account connected with fewer permissions is
asked to reconnect.

## Use from another app

From the consuming app's directory, an administrator grants a connection:

```sh
widefleet connect onedrive --as ONEDRIVE
```

Replace `onedrive` if you chose another name. Call the service while handling a
signed-in user's request so Widefleet forwards the verified caller identity.

Each offered Graph operation is a method. Items are addressed by their drive and
item IDs; `myDrive` returns the user's drive, and `root` names its top folder:

```ts
const drive = await env.ONEDRIVE.myDrive();
if (drive.status === "connected" && drive.data.id) {
  const files = await env.ONEDRIVE.listChildren({
    driveId: drive.data.id,
    driveItemId: "root",
    $top: 50,
    $select: ["id", "name", "size", "file", "folder"],
  });
  if (files.status === "connected") {
    for (const item of files.data.value ?? []) console.log(item.name, item.size);
  }
}
```

Graph's query options keep their names: `$select` returns only the listed
properties, and `$top`, `$filter`, `$orderby` and `$search` work as Graph describes
them. Every property in the result types is optional, so `$select` keeps them
correct. `$expand` adds related items, which the result types do not describe.

A list with more items carries `@odata.nextLink`. Pass it as `nextLink` to the same
method to read the next page; `delta` answers with `@odata.deltaLink`, which
`nextLink` also takes to read later changes.

`getContent` and `getVersionContent` return the file's temporary `downloadUrl`
without fetching the file. Download URLs grant temporary file access; open them in
the browser and keep them out of logs. `replaceContent` uploads text content of up to
250 MB. For larger or binary files, `createUploadSession` returns an upload address
to which the calling app sends the file.

See `src/api.ts` for every method, its input and Graph's description, and
`scripts/operations.ts` for the Graph operation behind each method.

## Approvals

Reading never asks. Methods that change data ask the user before they run, as their
approval level says:

- `all_changes`: every change asks.
- `updates_and_deletions`, the default: methods that change, share, move, restore
  or delete existing items, or invite people, ask; methods that only add items, such
  as a new folder or a copy, run at once.
- `none`: no method asks.

`scripts/operations.ts` records whether each method creates, updates, deletes or
sends. Users choose their level on the app's page. `approvalLevel` returns the
current level and `setApprovalLevel` changes it: asking more takes effect at once,
asking less asks the user to confirm.

A method that asks returns `input_required` with the method and its input. MCP
clients show the question to the user. A calling app shows it itself and answers with
`withInput`, as described in
[Ask the user before continuing](https://widefleet.com/docs/guides/app-services#ask-the-user-before-continuing).
A declined change returns `declined` and does not run.

## Results

`connected` holds the `data` Graph returned, or `null` for operations without a
result. `graph_error` carries Graph's error `code`, `message` and HTTP `status`, for
example `itemNotFound` or `nameAlreadyExists`. A `setup_required` result lists
missing secrets. `connection_required`, `reconnect_required` and
`permission_required` provide a `connectUrl` for the user. `authentication_required`
means the call has no signed-in user. Retry `refresh_failed` after a provider
outage; respect `retryAfter` for `rate_limited`. An input that does not match the
operation fails before anything is sent.

After connecting, verify a file listing through the consuming app. Users can
disconnect their account on the OneDrive app's page.

## Update the API

`src/api.ts` and `src/schema.ts` are generated from Microsoft Graph's published
OpenAPI description by the template generator in the Widefleet repository. To pick up
Graph's changes in your app, or to offer more operations, run from a checkout of that
repository with your app's directory:

```sh
pnpm --filter @platform/template-generator generate /path/to/your/app
```

The generator reads your app's `scripts/operations.ts` and rewrites `src/api.ts`,
`src/schema.ts` and the shared files it copies into `src`, such as `src/rest.ts` and
`src/approval.ts`. Keep your own changes out of these files. To offer another Graph
operation, add its operation ID with a method name and, unless it only reads, the
kind of change it makes. The generator stops when a listed operation no longer
exists. Review the diff before deploying.
