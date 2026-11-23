---
name: Business Central
description: Use Dynamics 365 Business Central's customers, items, sales and purchase documents, journals and general ledger through its API v2.0, with typed results.
---

Connect a work or school Microsoft account and use Dynamics 365 Business Central's
standard API v2.0 as typed methods: environments and companies, customers, vendors,
contacts, items, employees and projects, sales quotes, orders, invoices and credit
memos, purchase orders and invoices with their lines, posting and sending documents,
their PDFs, general journals, customer payments, time registration, the chart of
accounts, general ledger entries, dimensions and attachments. Each signed-in user
connects their own account and works with their own Business Central permissions.
Changes ask the user first, as each user's approval level says.

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

Installations whose managed OAuth for Microsoft allows Business Central's
`Financials.ReadWrite.All` permission need no registration: users connect their
accounts directly. Otherwise, an administrator needs to:

1. Register a Microsoft Entra application for **Accounts in any organizational
   directory**. The app signs users in through Microsoft's multi-tenant endpoint,
   which a registration for a single organization does not accept.
2. Add `https://YOUR-APP-URL/auth/callback/microsoft` as a **Web** redirect URI. On
   **API permissions**, add **Dynamics 365 Business Central** > **Delegated
   permissions** > `Financials.ReadWrite.All`.
3. Create a client secret. Set the app secrets `MICROSOFT_CLIENT_ID` and
   `MICROSOFT_CLIENT_SECRET`. Use the application client ID and the client secret's
   **value**, not its ID. Use the app's Secrets page or
   `widefleet secret put NAME --file /path/to/secret` to provide values.

Where the organization's consent settings do not let users consent to apps, a tenant
administrator grants `Financials.ReadWrite.All` once on the app registration's **API
permissions** page.

In both cases, allow the backend origins that `widefleet.jsonc` declares. A one-click
install from the template page allows them, as does `widefleet catalog templates
install` with the CLI's `network:manage` scope. After `widefleet deploy`, run from
the app directory:

```sh
widefleet network allow https://login.microsoftonline.com https://api.businesscentral.dynamics.com
```

Network changes require the CLI's `network:manage` scope. Wait for the configuration
to activate, then open the app URL and connect your Microsoft account.

Each user connects an account that is a user of the Business Central environment.
`Financials.ReadWrite.All` lets the app act as that user, so it reads and changes
only what the user's permission sets allow. An account connected without the
permission is asked to reconnect.

## Use from another app

From the consuming app's directory, an administrator grants a connection:

```sh
widefleet connect business-central --as BUSINESS_CENTRAL
```

Replace `business-central` if you chose another name. Call the service while handling
a signed-in user's request so Widefleet forwards the verified caller identity.

Every method takes the `environment` it works in, such as `production`, and the
methods of a company's data its `companyId`. `listEnvironments` returns the
environments of the user's tenant and `listCompanies` the companies of one:

```ts
const environments = await env.BUSINESS_CENTRAL.listEnvironments();
const environment =
  environments.status === "connected" ? environments.data.value?.[0]?.name : undefined;

if (environment) {
  const companies = await env.BUSINESS_CENTRAL.listCompanies({ environment });
  const companyId = companies.status === "connected" ? companies.data.value?.[0]?.id : undefined;

  if (companyId) {
    const open = await env.BUSINESS_CENTRAL.listSalesInvoices({
      environment,
      companyId,
      $filter: "status eq 'Open'",
      $expand: "salesInvoiceLines",
      $top: 20,
    });
    if (open.status === "connected") {
      for (const invoice of open.data.value ?? []) {
        console.log(invoice.number, invoice.customerName, invoice.totalAmountIncludingTax);
      }
    }
  }
}
```

A document can be created with its lines in one call. Posting it is an action of
its own, and its PDF arrives as `base64`:

```ts
const created = await env.BUSINESS_CENTRAL.createSalesInvoice({
  environment,
  companyId,
  body: {
    customerNumber: "10000",
    salesInvoiceLines: [{ lineType: "Item", lineObjectNumber: "1896-S", quantity: 3 }],
  },
});

if (created.status === "connected" && created.data.id) {
  const salesInvoiceId = created.data.id;
  await env.BUSINESS_CENTRAL.postSalesInvoice({ environment, companyId, salesInvoiceId });
  const pdf = await env.BUSINESS_CENTRAL.downloadSalesInvoicePdf({
    environment,
    companyId,
    salesInvoiceId,
  });
  if (pdf.status === "connected" && "base64" in pdf.data) {
    console.log(pdf.data.contentType, pdf.data.base64.length);
  }
}
```

Business Central changes and deletes an entity only at the version it was read at.
Pass its `@odata.etag` as `etag`:

```ts
const customer = await env.BUSINESS_CENTRAL.getCustomer({ environment, companyId, customerId });
if (customer.status === "connected" && customer.data["@odata.etag"]) {
  await env.BUSINESS_CENTRAL.updateCustomer({
    environment,
    companyId,
    customerId,
    etag: customer.data["@odata.etag"],
    body: { email: "accounts@example.com" },
  });
}
```

A document's lines are listed and created through their document, such as
`listSalesInvoiceLines` with `salesInvoiceId`, and read, changed and deleted by their
own `id`, such as `updateSalesInvoiceLine`. Journal lines and customer payments work
the same way with their journal.

OData's query options keep their names: `$filter`, `$select`, `$expand`, `$orderby`,
`$top` and `$skip`. A list with more entities carries `@odata.nextLink`: pass it as
`nextLink` to the same method to read the next page. See `src/api.ts` for every
method, its input and Microsoft's description, and `scripts/operations.ts` for the
operation behind each method.

## Approvals

Reading and downloading PDFs never ask. Changes ask the user before they run, as
their approval level says:

- `all_changes`: every change asks, including creating customers, documents and
  lines.
- `updates_and_deletions`, the default: changing and deleting entities, posting,
  shipping, receiving and cancelling documents, turning quotes into orders or
  invoices, and emailing documents to customers ask. Creating does not.
- `none`: no method asks.

`scripts/operations.ts` records the change each method makes. Users choose their
level on the app's page. `approvalLevel` returns the current level and
`setApprovalLevel` changes it: asking more takes effect at once, asking less asks the
user to confirm.

A method that asks returns `input_required` with the method and its input. MCP
clients show the question to the user. A calling app shows it itself and answers with
`withInput`, as described in
[Ask the user before continuing](https://widefleet.com/docs/guides/app-services#ask-the-user-before-continuing).
A declined change returns `declined` and does not run.

## Results

`connected` holds the `data` Business Central returned, or `null` for actions and
deletions. `business_central_error` carries Business Central's error `code`,
`message` and HTTP `status`, for example `BadRequest_NotFound`, or
`Request_EntityChanged` when the entity changed since its `etag` was read: read it
again and retry. A `setup_required` result lists missing secrets.
`connection_required`, `reconnect_required` and `permission_required` provide a
`connectUrl` for the user. `authentication_required` means the call has no signed-in
user. Retry `refresh_failed` after a provider outage; respect `retryAfter` for
`rate_limited`. `too_large` means the response is larger than `maximumBytes`
(8 MiB): read fewer entities per page or select fewer properties. Business Central
ends requests that run longer than ten minutes. An input that does not match the
operation fails before anything is sent.

After connecting, verify a company listing through the consuming app. Users can
disconnect their account on the Business Central app's page.

## Update the API

Microsoft publishes no OpenAPI description of Business Central's API v2.0.
`scripts/openapi.ts` builds one from Microsoft's sources: the AL source of the API
pages in [microsoft/BCApps](https://github.com/microsoft/BCApps), which decides the
entity sets, which properties can be written, which changes each set allows, its
subpages and its actions, and the
[API reference](https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/api-reference/v2.0/),
which gives each property's type and description. `src/api.ts` and `src/schema.ts`
are generated from that description by the template generator in the Widefleet
repository. To pick up Microsoft's changes in your app, or to offer more operations,
run from a checkout of that repository with your app's directory:

```sh
pnpm --filter @platform/template-generator generate /path/to/your/app
```

The generator reads your app's `scripts/operations.ts` and rewrites `src/api.ts`,
`src/schema.ts` and the shared files it copies into `src`, such as `src/rest.ts` and
`src/approval.ts`. Keep your own changes out of these files. To offer another
operation, add its operation ID with a method name and, unless it only reads with
GET, the kind of change it makes or `read`. The description names each operation by
its entity set and what it does, such as `vendors.list`, `salesOrders.shipAndInvoice`
or `salesInvoices.salesInvoiceLines.create`. The generator stops when a listed
operation no longer exists. Review the diff before deploying.
