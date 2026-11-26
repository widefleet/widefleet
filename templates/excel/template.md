---
name: Excel
description: Read and write Excel workbooks in OneDrive and SharePoint through Microsoft Graph, with typed ranges, tables and charts.
---

Read and write Excel workbooks in OneDrive and SharePoint from your agents and apps:
ranges, worksheets, tables, named ranges, charts and calculation. Each person
connects their own work or school Microsoft account.

## Set up

Install the template, open the app and connect your Microsoft account.

If the app asks for `MICROSOFT_CLIENT_ID` and `MICROSOFT_CLIENT_SECRET`, your
installation uses your own Microsoft Entra application:

1. Register an application for **Accounts in any organizational directory**.
2. Add `https://YOUR-APP-URL/auth/callback/microsoft` as a **Web** redirect URI and
   add the delegated Microsoft Graph permission `Files.ReadWrite.All`.
3. Create a client secret and save the application's client ID and the secret's
   **value** as `MICROSOFT_CLIENT_ID` and `MICROSOFT_CLIENT_SECRET` on the app's
   **Secrets** page.

## Use it

Ask your agent, for example "Update the totals in Budget.xlsx". To call it from your
own app, connect it from the app's directory:

```sh
widefleet connect excel --as EXCEL
```

Each Excel operation of Microsoft Graph is a method, such as `search`, `getRange`
and `updateRange`. See [using a template
app](https://widefleet.com/docs/guides/app-templates#use-from-agents-and-apps) for
calls, approvals and results.
