---
title: Connect personal accounts
description: Connect your own GitHub, Gmail or OneDrive account to the connectors in your organization.
lastModified: 2026-11-20
---

**My connections** lists the connectors in your organization that work with your
own provider account, such as GitHub, Gmail or OneDrive. Connect your account
once; every app that uses the connector then acts as you.

You need access to the connector app. Managing its deployment is not required.

## Connect an account

1. Open **My connections** in the workspace navigation.
2. Choose **Connect** beside a connector. The provider's sign-in opens.
3. Choose your account and approve the requested access.

You return to **My connections**, which shows the connected account's name or
email.

To grant new permissions or switch accounts, open **…** beside the account and
choose **Reconnect**. To remove the account, choose **Disconnect**; apps that use
the connector then stop acting as you.

## Make a connector available

Deploy the current [GitHub, Gmail or OneDrive template](/guides/app-templates)
and finish its provider setup. It then appears in **My connections** for every
member its [app access rules](/reference/app-access) admit. Copies deployed from earlier template versions appear after you deploy
the current code; their saved accounts stay connected.

Until provider credentials are set up, the connector shows **Awaiting
administrator setup**.

## Add support to your own connector

Export a `UserConnection` class extending `WorkerEntrypoint` with three methods:

| Method                       | Returns                          | Purpose                                                    |
| ---------------------------- | -------------------------------- | ---------------------------------------------------------- |
| `status()`                   | `{ setup, connection, account }` | Report the caller's account without starting sign-in.      |
| `prepare({ completionUrl })` | `{ url, expiresAt }`             | Create a single-use link that starts the provider sign-in. |
| `disconnect()`               | `{ disconnected: true }`         | Remove the caller's account.                               |

```ts
type ConnectionStatus = {
  setup: "ready" | "required";
  connection: "connected" | "disconnected";
  account: { id: string; label: string } | null;
};
```

Store accounts under the caller in `this.ctx.props.caller`, the same
[user identity](/guides/app-services#user-identity) your app receives on every
request. The link from `prepare()` must stay on your app's origin and expire
within five minutes. When the browser opens it, start the provider sign-in, then
return to `completionUrl`. Add `connectionError=1` if sign-in did not complete.

The [GitHub template](https://github.com/widefleet/widefleet/tree/main/templates/github/src)
is a complete example: `app.ts` exports the entrypoint, `connection-launch.ts`
issues the links, and `connection.ts` shares sign-in with the app's own page.

## Use the CLI or API

```sh
widefleet accounts list
widefleet accounts connect APP_UUID
widefleet accounts disconnect APP_UUID
```

`connect` prints a link to open in a browser where you are signed in. The
[API reference](/reference/api#personal-connector-accounts) lists the matching
endpoints.

## Sign in again

With company sign-in, **My connections** uses the identity and groups from your
latest company sign-in for seven days. When it asks you to sign in again, choose
**Sign in** and continue with your company account. Your connected accounts stay
as they are.
