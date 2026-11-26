---
name: Microsoft Teams
description: Read and send Microsoft Teams chat and channel messages through Microsoft Graph, with typed results.
---

Read and send messages in Microsoft Teams chats and channels from your agents and
apps, and start new chats. Each person connects their own work or school Microsoft
account.

## Set up

Install the template, open the app and connect your Microsoft account. A Microsoft
365 administrator approves the app once for the organization, on the consent page
when they connect their own account or on the app registration's **API permissions**
page.

If the app asks for `MICROSOFT_CLIENT_ID` and `MICROSOFT_CLIENT_SECRET`, your
installation uses your own Microsoft Entra application:

1. Register an application for **Accounts in any organizational directory**.
2. Add `https://YOUR-APP-URL/auth/callback/microsoft` as a **Web** redirect URI and
   add the delegated Microsoft Graph permissions `Chat.ReadWrite`,
   `ChatMessage.Send`, `Team.ReadBasic.All`, `Channel.ReadBasic.All`,
   `ChannelMessage.Read.All` and `ChannelMessage.Send`.
3. Create a client secret and save the application's client ID and the secret's
   **value** as `MICROSOFT_CLIENT_ID` and `MICROSOFT_CLIENT_SECRET` on the app's
   **Secrets** page.

## Use it

Ask your agent, for example "Post the release notes in the Engineering channel". To
call it from your own app, connect it from the app's directory:

```sh
widefleet connect teams --as TEAMS
```

Each Teams operation of Microsoft Graph is a method, such as `listChats`,
`sendChatMessage` and `replyToChannelMessage`. See [using a template
app](https://widefleet.com/docs/guides/app-templates#use-from-agents-and-apps) for
calls, approvals and results.
