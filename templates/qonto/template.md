---
name: Qonto
description: Read accounts and transactions and make transfers, cards and invoices in Qonto, with typed results and Qonto's own payment approval.
---

Connect a Qonto organization and use Qonto's Business API as typed methods: business
accounts, transactions with their attachments and labels, SEPA, internal and
international transfers, beneficiaries, transfer and card requests, SEPA Direct
Debit, cards, clients and products, client and supplier invoices, quotes, credit
notes, payment links, terminals, memberships, teams, insurance contracts and webhook
subscriptions. Each signed-in user connects their own Qonto account through the
organization's own Qonto app. Changes ask the user first, as each user's approval
level says, and payments Qonto protects wait for the user's approval in the Qonto app.

## Deploy

Read the [Widefleet app development guide](https://widefleet.com/docs/guides/app-development)
for CLI setup and authentication. Copy this directory into your project and run:

```sh
pnpm install
pnpm test
widefleet create qonto --name "Qonto"
widefleet secret put QONTO_CLIENT_ID --file /path/to/client-id
widefleet secret put QONTO_CLIENT_SECRET --file /path/to/client-secret
widefleet deploy
```

Choose the app name in `wrangler.jsonc` and create the app with that name. Its
deployments need the Qonto app from [Configure Qonto](#configure-qonto), which
`wrangler.jsonc` lists as required secrets. The CLI creates the app's declared
database. Keep your local source for subsequent changes.

Keep `pnpm-workspace.yaml` and `patches/` with the source. They patch Better Auth to
sign cookies and encrypt saved account tokens with the app's Widefleet keys, which
the app never reads.

## Configure Qonto

Each organization registers its own app in Qonto's Developer Portal. An administrator
needs to:

1. Sign in to the [Developer Portal](https://developers.qonto.com/) with **Sign in
   with Qonto** and create an app for the use case **Automate your business
   operations**. This use case covers the payment and account scopes the template
   requests and goes live without a review by Qonto. Add
   `https://YOUR-APP-URL/auth/callback/qonto` as a redirect URI for Production. You
   can add it once the app is installed and its URL is known.
2. Provide the app's Production client ID and client secret as the app secrets
   `QONTO_CLIENT_ID` and `QONTO_CLIENT_SECRET`. Installing from the template page asks
   for them; `widefleet catalog templates install` reads them with
   `--secret-file QONTO_CLIENT_ID=/path/to/client-id --secret-file QONTO_CLIENT_SECRET=/path/to/client-secret`.
   Change them later on the app's Secrets page or with
   `widefleet secret put NAME --file /path/to/secret`.
3. Allow the backend origins that `widefleet.jsonc` declares. A one-click install from
   the template page allows them, as does `widefleet catalog templates install` with
   the CLI's `network:manage` scope. After `widefleet deploy`, run from the app
   directory:

   ```sh
   widefleet network allow https://oauth.qonto.com https://thirdparty.qonto.com
   ```

Network changes require the CLI's `network:manage` scope. Wait for the configuration
to activate, then open the app URL and connect your Qonto account. Qonto asks which
organization to connect and shows the requested scopes, listed in `src/auth.ts`, with
`offline_access` to keep the connection through refreshed tokens. A user who
connected with fewer scopes is asked to reconnect. Each user acts with their own
Qonto role, so Qonto refuses what their role does not allow.

## Use from another app

From the consuming app's directory, an administrator grants a connection:

```sh
widefleet connect qonto --as QONTO
```

Replace `qonto` if you chose another name. Call the service while handling a
signed-in user's request so Widefleet forwards the verified caller identity.

Each offered Qonto operation is a method, such as `listBusinessAccounts`,
`listTransactions`, `verifyPayee` and `createSepaTransfer`. Inputs and results keep
Qonto's field names:

```ts
const transactions = await env.QONTO.listTransactions({
  iban: "FR7616798000010000004321396",
  "status[]": ["completed"],
  per_page: 50,
});
if (transactions.status === "connected") {
  for (const transaction of transactions.data.transactions ?? []) {
    console.log(transaction.settled_at, transaction.label, transaction.amount);
  }
}
```

Lists take `page` and `per_page` and answer with a `meta` object whose `next_page`
names the next page. A SEPA transfer is paid from one of the organization's business
accounts and first checks the payee:

```ts
const accounts = await env.QONTO.listBusinessAccounts();
const account = accounts.status === "connected" ? accounts.data.bank_accounts[0] : undefined;
const payee = await env.QONTO.verifyPayee({
  body: { iban: "DE89370400440532013000", beneficiary_name: "Acme GmbH" },
});
if (account && payee.status === "connected" && payee.data.proof_token) {
  const transfer = await env.QONTO.createSepaTransfer({
    body: {
      vop_proof_token: payee.data.proof_token.token,
      transfer: {
        beneficiary: { name: "Acme GmbH", iban: "DE89370400440532013000" },
        bank_account_id: account.id,
        reference: "Invoice 42",
        amount: "120.00",
      },
    },
  });
}
```

IBAN certificates, transfer proofs and credit notes return the file with its
`contentType`, up to 8 MiB. Uploads, such as `uploadAttachment`, take the file as
`{ mimeType, base64 }`. See `src/api.ts` for every method, its input and Qonto's
description, and `scripts/operations.ts` for the operation behind each method.

## Approvals

Reading never asks. Methods that change data ask the user before they run, as their
approval level says:

- `all_changes`: every change asks.
- `updates_and_deletions`, the default: payments, sent invoices and quotes, invited
  members, and changes and deletions ask; creating records such as clients or drafts
  runs at once.
- `none`: nothing asks.

`scripts/operations.ts` records whether each method creates, updates, deletes or
sends; payments send. Users choose their level on the app's page. `approvalLevel`
returns the current level and `setApprovalLevel` changes it: asking more takes effect
at once, asking less asks the user to confirm.

Qonto also protects payments with its own approval on the user's paired phone, for
example a transfer to a beneficiary the organization has not trusted. The method then
returns the question `approveInQonto`: the user approves in the Qonto app within 15
minutes and confirms, and the call finishes the payment. Until Qonto has the approval,
the call asks again; a refusal in the Qonto app returns `rejected_in_qonto`. Payments
to beneficiaries an administrator trusts in the Qonto web app run without this step.
The template leaves trusting beneficiaries and reviewing requests to Qonto, so these
approvals stay with the people Qonto names.

A method that asks returns `input_required` with its question. MCP clients show the
question to the user. A calling app shows it itself and answers with `withInput`,
passing back the `requestState` it received, as described in
[Ask the user before continuing](https://widefleet.com/docs/guides/app-services#ask-the-user-before-continuing).
A declined change returns `declined` and does not run.

## Results

`connected` holds the `data` Qonto returned, or `null` for changes Qonto answers
without content. `qonto_error` carries the HTTP `status`, Qonto's `errors` with their
`code`, `detail` and `source`, and the `traceId` Qonto support asks for. A transfer
above the organization's payment policy returns the code
`payment_policy_approval_required`: send it with `createTransferRequest` instead, and
an approver reviews it in Qonto. A `setup_required` result lists missing secrets.
`connection_required` and `reconnect_required` provide a `connectUrl` for the user;
`permission_required` means the user granted fewer scopes than the connector needs
and must reconnect. `authentication_required` means the call has no signed-in user.
Retry `refresh_failed` after a provider outage; respect `retryAfter` for
`rate_limited`. `too_large` means the response is larger than `maximumBytes` (8 MiB):
ask for fewer records. An input that does not match the operation fails before
anything is sent.

After connecting, verify a transaction listing through the consuming app. Users can
disconnect their account on the Qonto app's page; `revokeAccess` also ends the app's
access in Qonto.

## Update the API

`src/api.ts` and `src/schema.ts` are generated from the OpenAPI documents Qonto
publishes with each page of its API reference, which the generator joins into one
description. To pick up Qonto's changes in your app, or to offer more operations, run
from a checkout of the Widefleet repository with your app's directory:

```sh
pnpm --filter @platform/template-generator generate /path/to/your/app
```

The generator reads your app's `scripts/operations.ts` and rewrites `src/api.ts`,
`src/schema.ts` and the shared files it copies into `src`, such as `src/rest.ts` and
`src/approval.ts`. Keep your own changes out of these files. To offer another
operation, add its operation ID, or its method and path where Qonto gives no ID, with
a method name and, unless it only reads with GET, the kind of change it makes or
`read`. The generator stops when a listed operation no longer exists. Review the diff
before deploying.
