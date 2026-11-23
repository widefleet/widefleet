---
name: Microsoft Teams
description: Read and send Microsoft Teams chat and channel messages through Microsoft Graph, with typed results.
---

Connect a work or school Microsoft account and use Microsoft Teams' operations of
Microsoft Graph as typed methods: chats and their members and messages, new one-on-one
and group chats, quoted replies, the user's teams, their channels, and channel
messages and replies. Each signed-in user connects their own account. Sending asks
the user first, as each user's approval level says.

## Deploy

Read the [Widefleet app development guide](https://widefleet.com/docs/guides/app-development)
for CLI setup and authentication. Copy this directory into your project and run:

```sh
pnpm install
pnpm test
widefleet deploy
```

Choose the app name in `wrangler.jsonc` before deploying. The CLI creates the app
and its declared database. Keep your local source for subsequent changes.

Keep `pnpm-workspace.yaml` and `patches/` with the source. They patch Better Auth to
sign cookies and encrypt saved account tokens with the app's Widefleet keys, which
the app never reads.

## Configure Microsoft

Installations with managed OAuth for Microsoft need no registration: users connect
their accounts directly. Otherwise, an administrator needs to:

1. Register a Microsoft Entra application. Choose **Accounts in any organizational
   directory** or **Accounts in this organizational directory only**.
2. Add `https://YOUR-APP-URL/auth/callback/microsoft` as a **Web** redirect URI and
   add the delegated Microsoft Graph permissions `Chat.ReadWrite`, `ChatMessage.Send`,
   `Team.ReadBasic.All`, `Channel.ReadBasic.All`, `ChannelMessage.Read.All` and
   `ChannelMessage.Send`.
3. Create a client secret. Set the app secrets `MICROSOFT_CLIENT_ID` and
   `MICROSOFT_CLIENT_SECRET`. Use the application client ID and the client secret's
   **value**, not its ID. Use the app's Secrets page or
   `widefleet secret put NAME --file /path/to/secret` to provide values.

`ChannelMessage.Read.All` needs admin consent: a tenant administrator grants it once
for the organization on the app registration's **API permissions** page, or when
they first connect their own account. Until then, users of that organization cannot
connect.

In both cases, allow the backend origins that `widefleet.jsonc` declares. A one-click
install from the template page allows them, as does `widefleet catalog templates
install` with the CLI's `network:manage` scope. After `widefleet deploy`, run from
the app directory:

```sh
widefleet network allow https://login.microsoftonline.com https://graph.microsoft.com
```

Network changes require the CLI's `network:manage` scope. Wait for the configuration
to activate, then open the app URL and connect your Microsoft account. An account
connected with fewer permissions is asked to reconnect.

## Use from another app

From the consuming app's directory, an administrator grants a connection:

```sh
widefleet connect teams --as TEAMS
```

Replace `teams` if you chose another name. Call the service while handling a
signed-in user's request so Widefleet forwards the verified caller identity.

Each offered Graph operation is a method, such as `listChats`, `sendChatMessage`,
`listChannelMessages` and `replyToChannelMessage`. A message's `body` holds its
`content` as `text` or `html`:

```ts
const teams = await env.TEAMS.listJoinedTeams();
const team = teams.status === "connected" ? teams.data.value?.[0] : undefined;

if (team?.id) {
  const general = await env.TEAMS.getPrimaryChannel({ teamId: team.id });
  if (general.status === "connected" && general.data.id) {
    const messages = await env.TEAMS.listChannelMessages({
      teamId: team.id,
      channelId: general.data.id,
      $top: 10,
    });
    if (messages.status === "connected") {
      for (const message of messages.data.value ?? []) {
        console.log(message.from?.user?.displayName, message.body?.content);
      }
    }
  }
}
```

`createChat` starts a chat. Its `members` include the signed-in user, whose `id`
`me` returns, and bind each user by the address of their ID or user principal name:

```ts
const me = await env.TEAMS.me();
if (me.status === "connected" && me.data.id) {
  const member = (user: string) => ({
    "@odata.type": "#microsoft.graph.aadUserConversationMember",
    roles: ["owner"],
    "user@odata.bind": `https://graph.microsoft.com/v1.0/users('${user}')`,
  });
  const chat = await env.TEAMS.createChat({
    body: { chatType: "oneOnOne", members: [member(me.data.id), member("bob@example.com")] },
  });
  if (chat.status === "connected" && chat.data.id) {
    await env.TEAMS.sendChatMessage({
      chatId: chat.data.id,
      body: { body: { contentType: "text", content: "Hello" } },
    });
  }
}
```

A one-on-one chat with the same person returns the existing chat. Group chats take
`chatType: "group"`, an optional `topic` and two or more other members.

Treat message HTML as untrusted content. Graph's query options keep their names:
`$top` limits a page, and `$expand` and `$filter` work as Graph describes them for
each list. A list with more items carries `@odata.nextLink`: pass it as `nextLink` to
the same method to read the next page. See `src/api.ts` for every method, its input
and Graph's description, and `scripts/operations.ts` for the Graph operation behind
each method.

## Approvals

Reading never asks. Sending a chat or channel message, replying, and starting a chat
reach other people and ask the user before they run, as their approval level says:

- `all_changes` and `updates_and_deletions`, the default: every message and new
  chat asks.
- `none`: no method asks.

`scripts/operations.ts` records the change each method makes. Users choose their
level on the app's page. `approvalLevel` returns the current level and
`setApprovalLevel` changes it: asking more takes effect at once, asking less asks the
user to confirm.

A method that asks returns `input_required` with the method and its input. MCP
clients show the question to the user. A calling app shows it itself and answers with
`withInput`, as described in
[Ask the user before continuing](https://widefleet.com/docs/guides/app-services#ask-the-user-before-continuing).
A declined change returns `declined` and does not run.

## Results

`connected` holds the `data` Graph returned, or `null` for operations without a
result. `graph_error` carries Graph's error `code`, `message` and HTTP `status`, for
example `NotFound` or `Forbidden`. A `setup_required` result lists missing secrets.
`connection_required`, `reconnect_required` and `permission_required` provide a
`connectUrl` for the user. `authentication_required` means the call has no signed-in
user. Retry `refresh_failed` after a provider outage; respect `retryAfter` for
`rate_limited`. `too_large` means the response is larger than `maximumBytes`
(8 MiB): read fewer items per page. An input that does not match the operation fails
before anything is sent.

After connecting, verify a chat listing through the consuming app. Users can
disconnect their account on the Teams app's page.

## Update the API

`src/api.ts` and `src/schema.ts` are generated from Microsoft Graph's published
OpenAPI description by the template generator in the Widefleet repository. To pick up
Graph's changes in your app, or to offer more operations, run from a checkout of that
repository with your app's directory:

```sh
pnpm --filter @platform/template-generator generate /path/to/your/app
```

The generator reads your app's `scripts/operations.ts` and rewrites `src/api.ts`,
`src/schema.ts` and the shared files it copies into `src`, such as `src/rest.ts` and
`src/approval.ts`. Keep your own changes out of these files. To offer another Graph
operation, add its operation ID with a method name and, unless it only reads with
GET, the kind of change it makes or `read`. `bindings` lets a body bind navigation
properties by address, as `createChat` binds each member's `user`. The generator
stops when a listed operation no longer exists. Review the diff before deploying.
