---
name: OneDrive
description: Browse, search, upload, move and share OneDrive files through Microsoft Graph, with typed results.
---

Find, read, upload and share files in OneDrive from your agents and apps, including
versions and file changes. Work, school and personal accounts work. Each person
connects their own Microsoft account.

## Set up

Install the template, open the app and connect your Microsoft account.

If the app asks for `MICROSOFT_CLIENT_ID` and `MICROSOFT_CLIENT_SECRET`, your
installation uses your own Microsoft Entra application:

1. Register an application for **Accounts in any organizational directory and
   personal Microsoft accounts**.
2. Add `https://YOUR-APP-URL/auth/callback/microsoft` as a **Web** redirect URI and
   add the delegated Microsoft Graph permission `Files.ReadWrite.All`.
3. Create a client secret and save the application's client ID and the secret's
   **value** as `MICROSOFT_CLIENT_ID` and `MICROSOFT_CLIENT_SECRET` on the app's
   **Secrets** page.

## Use it

Ask your agent, for example "Find the contract PDF I saved last week". To call it
from your own app, connect it from the app's directory:

```sh
widefleet connect onedrive --as ONEDRIVE
```

Each OneDrive operation of Microsoft Graph is a method, such as `listChildren`,
`search` and `createLink`. See [using a template
app](https://widefleet.com/docs/guides/app-templates#use-from-agents-and-apps) for
calls, approvals and results.
