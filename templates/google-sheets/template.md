---
name: Google Sheets
description: Read and write spreadsheets through the complete Google Sheets API, with typed results.
secretHelp:
  GOOGLE_CLIENT_ID: >-
    Open your web application in [Google Cloud OAuth clients](https://console.cloud.google.com/auth/clients) and copy its client ID.
  GOOGLE_CLIENT_SECRET: >-
    Use the client secret for the same application in [Google Cloud OAuth clients](https://console.cloud.google.com/auth/clients).
---

Read and write Google Sheets from your agents and apps: cell values, sheets,
formatting and charts. Each person connects their own Google account.

## Set up

The app signs people in with your organization's Google OAuth client:

1. In a Google Cloud project, enable the Google Sheets API and configure the OAuth
   consent screen with the scope `https://www.googleapis.com/auth/spreadsheets`.
   With the user type **Internal**, everyone in your Google Workspace can connect
   right away. An external app needs Google's verification for this scope.
2. Create an OAuth client of the type **Web application** and add
   `https://YOUR-APP-HOST/auth/callback/google` as an authorized redirect URI.
3. Enter the client ID and secret as `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`
   and install the template.

Then open the app and connect your Google account.

## Use it

Ask your agent, for example "Add this week's numbers to the sales sheet". To call it
from your own app, connect it from the app's directory:

```sh
widefleet connect google-sheets --as SHEETS
```

Every method of the Google Sheets API is a method named after its resource and
action, such as `valuesGet`, `valuesAppend` and `batchUpdate`. See [using a template
app](https://widefleet.com/docs/guides/app-templates#use-from-agents-and-apps) for
calls, approvals and results.
