---
title: Gmail app example
description: Set up the Gmail app from the app template catalog.
lastModified: 2026-11-18
---

The Gmail app lets each signed-in user connect their own Google account. Your other
apps can then search that user's mail, read messages and download attachments
through an [app connection](/guides/app-services). Access is read-only
(`gmail.readonly`).

## What you need

- Organization administrator access and the [Widefleet CLI](/getting-started/installation).
- A Google OAuth client of the **Web application** type with the Gmail API enabled,
  unless your installation provides one for templates. The app's page lists the
  secrets it still needs.
- An `AUTH_SECRET` app secret: a random value of at least 32 characters. Keep it
  stable; it encrypts the saved account tokens.
- Network access from the app to Google's sign-in and Gmail APIs.

## Set it up

1. Open **App catalog → Templates**, choose **Gmail** and follow
   [Use an app template](/guides/app-templates). An agent can read the same
   instructions with `widefleet catalog templates show gmail`.
2. Follow the template's steps to deploy the app, set its secrets and allow Google's
   network origins.
3. Open the app URL and choose **Connect account**.

The page then shows **Gmail connected** with your linked account. Other users
connect their own accounts the same way.

## Use it from another app

From the consuming app's directory, connect it to the Gmail app:

```sh
widefleet connect gmail --as GMAIL
```

Call the service while handling a signed-in user's request, so Widefleet passes the
user's identity:

```ts
const result = await env.GMAIL.searchMessages({ query: "has:attachment", maxResults: 10 });
```

The app provides `connectionStatus`, `searchMessages`, `getMessage` and
`getAttachment`. If the user hasn't connected an account yet, the result includes a
`connectUrl` to send them to. Treat email HTML as untrusted content. The template's
instructions list all result states and limits.
