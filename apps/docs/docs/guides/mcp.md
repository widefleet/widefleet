---
title: Connect AI clients with MCP
description: Use your organization's app services from Claude and other MCP clients.
lastModified: 2026-11-18
---

Connect an AI client such as Claude to Widefleet. The client can then find the
app services available to you, read their documentation and call them for you.
You sign in with your company account, and each app's existing access rules apply.

You need an MCP client that supports remote servers with OAuth sign-in.
Self-hosted installations need Widefleet **0.7.6 or newer** with
[the matching app runtime active](/reference/runtime#versions-and-updates).

## Connect your client

Add a remote MCP server with your installation's address:

| Installation    | Server address                                                        |
| --------------- | --------------------------------------------------------------------- |
| Widefleet Cloud | `https://mcp.widefleet.app/mcp`                                       |
| Self-hosted     | `https://mcp.APP_DOMAIN/mcp`, e.g. `https://mcp.apps.example.com/mcp` |

The client opens the Widefleet connection page in your browser:

- If you are already signed in to an app, choose **Continue as** your account and organization.
- Otherwise choose **Google** or **Microsoft** and sign in with your company account.
  If the account belongs to several organizations, select one.
- If your organization signs in with another provider, choose **Continue with Widefleet**.

The client then shows Widefleet as connected. Ask it which Widefleet services are
available to you to check the connection.

## Use app services

The client gets five tools:

| Tool       | Purpose                                                     |
| ---------- | ----------------------------------------------------------- |
| `search`   | Find services available to you.                             |
| `describe` | Read a service's method signatures and documentation.       |
| `call`     | Call a service method.                                      |
| `execute`  | Combine several calls in a short JavaScript script.         |
| `skills`   | Read the `widefleet` skill for building and deploying apps. |

A client typically searches for a service, describes it and then calls a method.
For a service with a `Reader.status()` method, the `call` arguments are:

```json
{
  "hostname": "inventory.apps.example.com",
  "entrypoint": "Reader",
  "method": "status",
  "arguments": []
}
```

Arguments and results are JSON. The method documentation comes from the
service's [TSDoc comments](/guides/app-services#document-service-methods) and is
published with every deployment. Each call carries your identity, so the service
can apply its own permissions to individual records.

A service can [ask you to confirm](/guides/app-services#ask-the-user-before-continuing)
an action or fill in a short form before it continues. Clients on protocol revision
2026-07-28 that support input dialogs, such as Claude Code and claude.ai,
show the question in their own dialog. Clients that render MCP Apps, such as
ChatGPT and Microsoft 365 Copilot, show it as a form in the conversation. The
agent cannot answer in your place: the answer comes only from the dialog or the
form. Other clients report that the service needs input they cannot ask for.

### Combine calls

`execute` runs a script that calls several services and returns one result. This
saves round trips when the client needs data from more than one service:

```js
const status = await tools.call({
  hostname: "inventory.apps.example.com",
  entrypoint: "Reader",
  method: "status",
  arguments: [],
});
return { configured: status.configured };
```

Scripts use `async`/`await`, loops and data transformations, and reach services
through `tools.call`. A script can make up to 32 calls, run for 30 seconds and
return up to 1 MiB of JSON plus 5 MiB of base64-encoded images and files, about
3.7 MiB of file content. Calls that completed before an error keep their effects,
so check them before running a script again.

### Return images and files

A script returns an image or a file as an MCP block, anywhere in its result. The
client receives it as an image the model sees or as a file, and the JSON keeps the
block's `contentIndex` in its place:

```js
const file = await tools.call({
  hostname: "drive.apps.example.com",
  entrypoint: "GoogleDriveApi",
  method: "filesGetContent",
  arguments: [{ fileId: "1a2b3c" }],
});
if (file.status !== "connected") return file;
return { type: "image", mimeType: file.data.contentType, data: file.data.base64 };
```

Return other files as `{ type: "resource", resource: { uri, mimeType, blob } }`
with base64 `blob`, and text as text.

### Build apps

The `widefleet` skill teaches the client to create and deploy apps with the
[CLI](/reference/cli). Clients read it through the `skills` tool or as the
`skill://widefleet/SKILL.md` resource.

## Choose who can use an app's services

MCP follows each app's **Access → App access** rules. Everyone who may open an
app can use all of its published service methods, including methods that change
data. To limit an app's services to specific people, restrict its groups:

```sh
widefleet access set --app inventory --group warehouse-readers
```

[App access](/reference/app-access) describes group IDs and activation.

## Troubleshooting

- **A service is missing:** check that you connected the right organization and
  that the app's access groups include you.
- **A service has no method documentation:** redeploy it with the current CLI.
  See [missing API documentation](/guides/app-services#missing-api-documentation).
- **Sign-in fails after choosing Google or Microsoft:** ask your administrator to
  check the [MCP redirect addresses](/reference/social-sign-in#configure-an-installation).
- **The client asks you to sign in again:** reconnect Widefleet in the client.

Next, [publish a service](/guides/app-services#publish-a-service) to make your
own app available to AI clients.
