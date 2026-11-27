---
name: Qonto
description: Read accounts and transactions and make transfers, cards and invoices in Qonto, with typed results and Qonto's own payment approval.
secretHelp:
  QONTO_CLIENT_ID: >-
    Open your app in [Qonto Developer Portal](https://developers.qonto.com/) and copy its Production client ID.
  QONTO_CLIENT_SECRET: >-
    Use the Production client secret for the same application in [Qonto Developer Portal](https://developers.qonto.com/).
---

Read accounts and transactions and make transfers, cards and invoices in Qonto from
your agents and apps. Each person connects their own Qonto account and acts with
their Qonto role. Payments that Qonto protects are approved in the Qonto app.

## Set up

1. Sign in to the [Qonto Developer Portal](https://developers.qonto.com/) with
   **Sign in with Qonto** and create an app for the use case **Automate your
   business operations**.
2. Add `https://YOUR-APP-URL/auth/callback/qonto` as a redirect URI. You can add it
   once the app is installed and its URL is known.
3. Under **Scopes**, select every scope except `beneficiary.trust`,
   `request_review.write` and `embed_auth_link.write`. Only people in the Qonto app
   can then trust beneficiaries and approve requests.
4. Create the app. It starts in the Sandbox with test data; publish it to Production
   from the app's page.
5. Enter the Production client ID and secret as `QONTO_CLIENT_ID` and
   `QONTO_CLIENT_SECRET` and install the template.

Then open the app and connect your Qonto account.

## Use it

Ask your agent, for example "List last month's card transactions without a receipt".
To call it from your own app, connect it from the app's directory:

```sh
widefleet connect qonto --as QONTO
```

Each Qonto Business API operation is a method, such as `listTransactions`,
`verifyPayee` and `createSepaTransfer`. See [using a template
app](https://widefleet.com/docs/guides/app-templates#use-from-agents-and-apps) for
calls, approvals and results.

For a payment that Qonto protects, the person approves it on their paired phone in
the Qonto app and then confirms, and the payment completes.
