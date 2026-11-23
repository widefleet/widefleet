---
name: Google Sheets
description: Read and write spreadsheets through the complete Google Sheets API, with typed results.
---

Connect a personal Google account and use every method of the Google Sheets API as a
typed method: cell values, spreadsheets, sheets, formatting, charts and developer
metadata. Each signed-in user connects their own account. Changes ask the user first,
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

## Configure Google

An administrator needs to:

1. Create a Google Cloud project, enable the Google Sheets API and configure the
   OAuth consent screen with the scope `https://www.googleapis.com/auth/spreadsheets`.
   Google classifies it as sensitive: an external app needs Google's verification
   before people outside its test users can connect. An internal app of a Google
   Workspace organization does not.
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
requests access to the user's spreadsheets, which every method of the API accepts. It
does not request access to Drive.

## Use from another app

From the consuming app's directory, an administrator grants a connection:

```sh
widefleet connect google-sheets --as SHEETS
```

Replace `google-sheets` if you chose another name. Call the service while handling a
signed-in user's request so Widefleet forwards the verified caller identity.

Each method of the Google Sheets API is a method named after its resource and action,
such as `get` for a spreadsheet, `valuesGet`, `valuesUpdate`, `valuesAppend` and
`batchUpdate`. Ranges use A1 notation, such as `Expenses!A2:C`. Methods that return
data take the fields to return, and the result has exactly the selected fields:

```ts
const range = await env.SHEETS.valuesGet(
  {
    spreadsheetId: "SPREADSHEET-ID",
    range: "Expenses!A2:C",
    valueRenderOption: "UNFORMATTED_VALUE",
  },
  { values: true },
);
if (range.status === "connected") {
  for (const [date, item, amount] of range.data.values ?? []) console.log(date, item, amount);
}
```

A selection names a field with `true`, or with a nested selection for an object. It
becomes Google's `fields` parameter, so Google Sheets returns only those fields. Select
few fields from `get`: a spreadsheet with `includeGridData` can be large. Google omits
fields it has no value for; they are `undefined` in the result. See `src/api.ts` for
every method, its input and Google's description.

## Approvals

Reading never asks, and neither do `getByDataFilter`, `valuesBatchGetByDataFilter`
and `developerMetadataSearch`, which read through a POST. Methods that change data ask
the user before they run, as their approval level says:

- `all_changes`: every change asks.
- `updates_and_deletions`, the default: writing, appending or clearing cells and
  `batchUpdate`, which can change or delete sheets, ask. Creating a spreadsheet or
  copying a sheet into a spreadsheet runs at once.
- `none`: nothing asks.

`valuesAppend` counts as an update: with `insertDataOption: "OVERWRITE"`, the default,
it can overwrite cells below a table. `scripts/operations.ts` records whether each
method creates, updates, deletes or sends. Users choose their level on the app's page.
`approvalLevel` returns the current level and `setApprovalLevel` changes it: asking
more takes effect at once, asking less asks the user to confirm.

A method that asks returns `input_required` with the method and its input. MCP clients
show the question to the user. A calling app shows it itself and answers with
`withInput`, as described in
[Ask the user before continuing](https://widefleet.com/docs/guides/app-services#ask-the-user-before-continuing).
A declined change returns `declined` and does not run.

## Results

`connected` holds the selected `data`, or `null` for methods without a result.
`sheets_error` carries Google's message, HTTP status, status and reasons, for example
for an unknown spreadsheet or range. A `setup_required` result lists missing secrets.
`connection_required` and `reconnect_required` provide a `connectUrl` for the user;
`permission_required` means the account granted fewer scopes than the connector needs
and must reconnect. `authentication_required` means the call has no signed-in user.
Retry `refresh_failed` after a provider outage; respect `retryAfter` for
`rate_limited`. `too_large` means the response is larger than `maximumBytes` (8 MiB):
select fewer fields or a smaller range. A selection or input that does not match the
method fails before anything is sent.

After connecting, verify a range read through the consuming app. Users can
disconnect their account on the Google Sheets app's page.

## Update the API

`src/api.ts` and `src/schema.ts` are generated from Google's Discovery document for
the Google Sheets API by the template generator in the Widefleet repository. To pick
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
