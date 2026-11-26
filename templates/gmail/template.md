---
name: Gmail
description: Read, search, send and organize email through the complete Gmail API, with typed results.
secretHelp:
  GOOGLE_CLIENT_ID: >-
    Open your web application in [Google Cloud OAuth clients](https://console.cloud.google.com/auth/clients) and copy its client ID.
  GOOGLE_CLIENT_SECRET: >-
    Use the client secret for the same application in [Google Cloud OAuth clients](https://console.cloud.google.com/auth/clients).
---

Read, search, send and organize email from your agents and apps: messages, threads,
drafts, labels, filters and settings. Each person connects their own Google account.

## Set up

The app signs people in with your organization's Google OAuth client:

1. In a Google Cloud project, enable the Gmail API and configure the OAuth consent
   screen with the scopes `https://mail.google.com/` and
   `https://www.googleapis.com/auth/gmail.settings.basic`. With the user type
   **Internal**, everyone in your Google Workspace can connect right away. An
   external app needs Google's verification and security assessment for these scopes.
2. Create an OAuth client of the type **Web application** and add
   `https://YOUR-APP-URL/auth/callback/google` as an authorized redirect URI. You
   can add it once the app is installed and its URL is known.
3. Enter the client ID and secret as `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`
   and install the template.

Then open the app and connect your Google account.

## Use it

Ask your agent, for example "Summarize my unread emails from today". To call it from
your own app, connect it from the app's directory:

```sh
widefleet connect gmail --as GMAIL
```

Every method of the Gmail API is a method named after its resource and action, such
as `messagesList`, `messagesSend` and `labelsCreate`. See [using a template
app](https://widefleet.com/docs/guides/app-templates#use-from-agents-and-apps) for
calls, approvals and results.
