---
name: Excel
description: Read and write Excel workbooks in OneDrive and SharePoint through Microsoft Graph, with typed ranges, tables and charts.
---

Connect a work or school Microsoft account and use Excel's operations of Microsoft
Graph as typed methods: find workbooks, read and write ranges, and work with
worksheets, tables and their rows, named ranges, charts and calculation. Workbooks in
OneDrive for Business and SharePoint document libraries work in the Office Open XML
format (`.xlsx`). Each signed-in user connects their own account. Changes ask the
user first, as each user's approval level says.

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
   directory**; the connection signs in through Microsoft's multi-tenant endpoint.
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

The connector requests `Files.ReadWrite.All`, which covers the user's own workbooks
and the workbooks others share with them. An account connected with fewer
permissions is asked to reconnect.

## Use from another app

From the consuming app's directory, an administrator grants a connection:

```sh
widefleet connect excel --as EXCEL
```

Replace `excel` if you chose another name. Call the service while handling a
signed-in user's request so Widefleet forwards the verified caller identity.

Each offered Graph operation is a method. A workbook is addressed by its drive and
item IDs: `myDrive` returns the user's drive, and `search` finds workbooks in it.
Worksheets, tables and names are addressed by their ID or name:

```ts
const drive = await env.EXCEL.myDrive();
const found =
  drive.status === "connected" && drive.data.id
    ? await env.EXCEL.search({ driveId: drive.data.id, q: "Budget.xlsx" })
    : null;
const workbook = found?.status === "connected" ? found.data.value?.[0] : undefined;

if (drive.status === "connected" && drive.data.id && workbook?.id) {
  const at = { driveId: drive.data.id, driveItemId: workbook.id, workbookWorksheetId: "Sheet1" };
  const range = await env.EXCEL.getRange({ ...at, address: "A1:C10" });
  if (range.status === "connected") console.log(range.data?.values);

  await env.EXCEL.updateRange({
    ...at,
    address: "D2:D3",
    body: { formulas: [["=SUM(A2:C2)"], ["=SUM(A3:C3)"]] },
  });
}
```

`getRange`, `usedRange` and `getNamedRange` return `values`, `formulas`, `text` and
`numberFormat` as one list of cells per row. `updateRange` writes them the same way
and leaves cells given as `null` unchanged. Whole columns or rows, such as `C:C`,
read with `null` cell values: use `usedRange` or a bounded address. Tables keep their
data together: `listTableRows` reads rows with their index and values, and
`addTableRows` appends rows.

Graph's query options keep their names: `$select` returns only the listed
properties, and `$top`, `$filter` and `$orderby` work as Graph describes them. A list
with more items carries `@odata.nextLink`: pass it as `nextLink` to the same method to
read the next page. See `src/api.ts` for every method, its input and Graph's
description, and `scripts/operations.ts` for the Graph operation behind each method.

### Sessions

Every workbook method takes an optional `sessionId`. Without it, each call opens the
workbook and saves its changes directly, which suits single calls. For a series of
calls, `createSession` with `{ persistChanges: true }` returns a session `id` that
makes them faster; its changes are saved to the workbook. With `persistChanges:
false`, changes stay in a temporary copy, which is useful for calculating results
or rendering chart images without changing the file. A persistent session ends
after about five minutes without calls and a temporary one after about seven:
`refreshSession` keeps it open and `closeSession` ends it. A call in an ended session
returns `graph_error` with status 404; create a new session and continue.

## Approvals

Reading never asks, and neither do the session methods. Methods that change data ask
the user before they run, as their approval level says:

- `all_changes`: every change asks.
- `updates_and_deletions`, the default: writing, inserting, clearing or deleting
  ranges, changing or deleting worksheets, tables, rows, columns, names and charts,
  and recalculating ask. Adding worksheets, tables, rows, columns, names and charts
  runs at once.
- `none`: no method asks.

`scripts/operations.ts` records whether each method creates, updates or deletes.
Users choose their level on the app's page. `approvalLevel` returns the current level
and `setApprovalLevel` changes it: asking more takes effect at once, asking less asks
the user to confirm.

A method that asks returns `input_required` with the method and its input. MCP
clients show the question to the user. A calling app shows it itself and answers with
`withInput`, as described in
[Ask the user before continuing](https://widefleet.com/docs/guides/app-services#ask-the-user-before-continuing).
A declined change returns `declined` and does not run.

## Results

`connected` holds the `data` Graph returned, or `null` for operations without a
result. `graph_error` carries Graph's error `code`, `message` and HTTP `status`, for
example `itemNotFound` or `invalidArgument`. A `setup_required` result lists missing
secrets. `connection_required`, `reconnect_required` and `permission_required`
provide a `connectUrl` for the user. `authentication_required` means the call has no
signed-in user. Retry `refresh_failed` after a provider outage; respect `retryAfter`
for `rate_limited`. `too_large` means the response is larger than `maximumBytes`
(8 MiB): read smaller ranges or select fewer properties. An input that does not match
the operation fails before anything is sent.

After connecting, verify a worksheet listing through the consuming app. Users can
disconnect their account on the Excel app's page.

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
operation, add its operation ID with a method name and, unless it only reads with
GET, the kind of change it makes or `read`. `headers: session` lets it take a
`sessionId`. `undescribed` lists operations Graph serves but its description leaves
out, such as `updateRange`. The generator stops when a listed operation no longer
exists. Review the diff before deploying.
