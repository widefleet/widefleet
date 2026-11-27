---
name: Outlook
description: Read, draft and send email and manage calendars and contacts in Outlook through Microsoft Graph, with typed results.
---

Read, send and organize email, plan meetings and manage contacts in Outlook from
your agents and apps. Work, school and personal accounts work. Each person connects
their own Microsoft account.

## Set up

Install the template, open the app and connect your Microsoft account.

If the app asks for `MICROSOFT_CLIENT_ID` and `MICROSOFT_CLIENT_SECRET`, your
installation uses your own Microsoft Entra application:

1. Register an application for **Accounts in any organizational directory and
   personal Microsoft accounts**.
2. Add `https://YOUR-APP-HOST/auth/callback/microsoft` as a **Web** redirect URI and
   add the delegated Microsoft Graph permissions `Mail.ReadWrite`, `Mail.Send`,
   `Calendars.ReadWrite`, `Contacts.ReadWrite` and `MailboxSettings.ReadWrite`.
3. Create a client secret and save the application's client ID and the secret's
   **value** as `MICROSOFT_CLIENT_ID` and `MICROSOFT_CLIENT_SECRET` on the app's
   **Secrets** page.

## Use it

Ask your agent, for example "Draft a reply to the latest email from our accountant".
To call it from your own app, connect it from the app's directory:

```sh
widefleet connect outlook --as OUTLOOK
```

Each Outlook operation of Microsoft Graph is a method, such as `listFolderMessages`,
`sendMail` and `createEvent`. See [using a template
app](https://widefleet.com/docs/guides/app-templates#use-from-agents-and-apps) for
calls, approvals and results.
