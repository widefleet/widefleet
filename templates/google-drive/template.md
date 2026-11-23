---
name: Google Drive
description: Find, read, upload, organize and share files through the complete Google Drive API, with typed results.
---

Connect a personal Google account and use every method of the Google Drive API as a
typed method: files and folders with their content, shared drives, sharing, comments
and replies, revisions, approvals and change tracking. Each signed-in user connects
their own account. Changes ask the user first, as each user's approval level says.

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

## Configure Google

An administrator needs to:

1. Create a Google Cloud project, enable the Google Drive API and configure the OAuth
   consent screen with the scope `https://www.googleapis.com/auth/drive`. Google
   classifies it as restricted: an external app needs Google's verification and
   security assessment before people outside its test users can connect. An internal
   app of a Google Workspace organization does not.
2. Create an OAuth client with the **Web application** type. Register
   `https://YOUR-APP-URL/auth/callback/google` as an authorized redirect URI.
3. Set the app secrets `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. Use the app's
   Secrets page or `widefleet secret put NAME --file /path/to/secret` to provide
   values.
4. Allow the backend origins that `widefleet.jsonc` declares. A one-click install
   from the template page allows them, as does `widefleet catalog templates install`
   with the CLI's `network:manage` scope. After `widefleet deploy`, run from the app
   directory:

   ```sh
   widefleet network allow https://accounts.google.com https://oauth2.googleapis.com https://www.googleapis.com
   ```

Network changes require the CLI's `network:manage` scope. Wait for the configuration
to activate, then open the app URL and connect your Google account. The connector
requests full access to Google Drive, which every offered method accepts.

## Use from another app

From the consuming app's directory, an administrator grants a connection:

```sh
widefleet connect google-drive --as DRIVE
```

Replace `google-drive` if you chose another name. Call the service while handling a
signed-in user's request so Widefleet forwards the verified caller identity.

Each method of the Google Drive API is a method named after its resource and action,
such as `filesList`, `filesGet`, `filesCreate`, `permissionsCreate` and
`commentsList`. Methods that return data take the fields to return, and the result has
exactly the selected fields:

```ts
const found = await env.DRIVE.filesList(
  { q: "name contains 'budget' and trashed = false", pageSize: 10 },
  { files: { id: true, name: true, mimeType: true } },
);
if (found.status === "connected") {
  for (const file of found.data.files ?? []) console.log(file.name, file.mimeType);
}
```

A selection names a field with `true`, or with a nested selection for an object. It
becomes Google's `fields` parameter, so Google Drive returns only those fields. Google
omits fields it has no value for; they are `undefined` in the result. See `src/api.ts`
for every method, its input and Google's description.

### File content

`filesGetContent` and `revisionsGetContent` return a file's content with its
`contentType`: as `text` for text media types, such as `text/csv` or JSON, and as
`base64` for others. `filesExport` converts a Google Docs, Sheets or Slides file to
another type, such as `text/plain` or `application/pdf`.
Results carry content up to 8 MiB; larger files return `too_large`. Through MCP,
results are limited to 1 MiB.

`filesCreateWithContent` and `filesUpdateWithContent` send a file's metadata and
content in one upload. The content has its `mimeType` and either `text`, sent as UTF-8,
or `base64`, for any other bytes, including text in another charset:

```ts
const created = await env.DRIVE.filesCreateWithContent(
  {
    body: { name: "notes.md", parents: ["FOLDER-ID"] },
    content: { mimeType: "text/markdown", text: "# Notes" },
  },
  { id: true, webViewLink: true },
);
```

## Approvals

Reading never asks, and neither does `filesDownload`, which starts a download through
a POST. Methods that change data ask the user before they run, as their approval
level says:

- `all_changes`: every change asks.
- `updates_and_deletions`, the default: changing, moving or deleting files, emptying
  the trash, changing shared drives, revisions and comments, `permissionsCreate`,
  which shares with people and emails them unless `sendNotificationEmail` is false,
  starting or commenting on an approval, which notifies its participants, and replies,
  which can resolve or reopen a comment, ask. Creating or copying files, folders and
  shared drives and adding comments to files run at once.
- `none`: nothing asks.

`...WithContent` methods ask like the method they extend. `scripts/operations.ts`
records whether each method creates, updates, deletes or sends. Users choose their
level on the app's page. `approvalLevel` returns the current level and
`setApprovalLevel` changes it: asking more takes effect at once, asking less asks the
user to confirm.

A method that asks returns `input_required` with the method and its input. MCP clients
show the question to the user. A calling app shows it itself and answers with
`withInput`, as described in
[Ask the user before continuing](https://widefleet.com/docs/guides/app-services#ask-the-user-before-continuing).
A declined change returns `declined` and does not run.

`scripts/operations.ts` lists the methods that are not offered, with the reason: the
replaced team drive methods, client-side encryption tokens and the user's installed
Drive apps.

## Results

`connected` holds the selected `data`, or `null` for methods without a result.
`drive_error` carries Google's message, HTTP status, status and reasons, for
example for an unknown file. A `setup_required` result lists missing secrets.
`connection_required` and `reconnect_required` provide a `connectUrl` for the user;
`permission_required` means the account granted fewer scopes than the connector needs
and must reconnect. `authentication_required` means the call has no signed-in user.
Retry `refresh_failed` after a provider outage; respect `retryAfter` for
`rate_limited`. `too_large` means the response is larger than `maximumBytes` (8 MiB):
select fewer fields or fewer files. A selection or input that does not match the
method fails before anything is sent.

After connecting, verify a file listing through the consuming app. Users can
disconnect their account on the Google Drive app's page.

## Update the API

`src/api.ts` and `src/schema.ts` are generated from Google's Discovery document for
the Google Drive API by the template generator in the Widefleet repository. To pick
up Google's changes in your app, run from a checkout of that repository with your
app's directory:

```sh
pnpm --filter @platform/template-generator generate /path/to/your/app
```

The generator reads your app's `scripts/operations.ts` and rewrites `src/api.ts`,
`src/schema.ts` and the shared files it copies into `src`, such as `src/google.ts`
and `src/approval.ts`. Keep your own changes out of these files. The generator stops
when Google adds a method that changes data and `scripts/operations.ts` does not list
yet: add it with the kind of change it makes, as `read` when it only reads, or with
the reason it is not offered. It also stops when an offered method does not accept the
scope that `scripts/operations.ts` names. Review the diff before deploying.
