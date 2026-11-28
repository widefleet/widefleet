---
name: Google Drive
description: Find, read, upload, organize and share files through the complete Google Drive API, with typed results.
secretHelp:
  GOOGLE_CLIENT_ID: >-
    Open your web application in [Google Cloud OAuth clients](https://console.cloud.google.com/auth/clients) and copy its client ID.
  GOOGLE_CLIENT_SECRET: >-
    Use the client secret for the same application in [Google Cloud OAuth clients](https://console.cloud.google.com/auth/clients).
---

Find, read, create and share files and folders in Google Drive and shared drives
from your agents and apps, including comments and revisions. Each person connects
their own Google account.

## Set up

The app signs people in with your organization's Google OAuth client:

1. In a Google Cloud project, enable the Google Drive API and configure the OAuth
   consent screen with the scope `https://www.googleapis.com/auth/drive`. With the
   user type **Internal**, everyone in your Google Workspace can connect right away.
   An external app needs Google's verification and security assessment for this
   scope.
2. Create an OAuth client of the type **Web application** and add
   `https://YOUR-APP-HOST/auth/callback/google` as an authorized redirect URI.
3. Enter the client ID and secret as `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`
   and install the template.

Then open the app and connect your Google account.

## Use it

Ask your agent, for example "Find the latest version of our pricing deck". To call
it from your own app, connect it from the app's directory:

```sh
widefleet connect google-drive --as DRIVE
```

Google Drive API methods are methods named after their resource and action, such as
`filesList`, `filesCreateWithContent` and `permissionsCreate`. The replaced team
drives methods, client-side encrypted files and installed Drive apps are left out.
See [using a template
app](https://widefleet.com/docs/guides/app-templates#use-from-agents-and-apps) for
calls, approvals and results.
