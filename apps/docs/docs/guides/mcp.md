---
title: Connect AI clients with MCP
description: Use your organization's app services from Claude and other MCP clients.
lastModified: 2026-11-19
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

- Choose your organization if the page lists it. It lists organizations you are
  signed in to in an app and organizations you connected before in this browser.
- Otherwise enter your work email and choose **Continue with email**. Widefleet opens your
  company sign-in.
- If you are a guest in the organization, or your organization signs in with
  Widefleet, choose **Continue with Widefleet** and select the organization.

The client then shows Widefleet as connected. Ask it which Widefleet services are
available to you to check the connection.

## Use app services

The client gets six tools:

| Tool        | Purpose                                                       |
| ----------- | ------------------------------------------------------------- |
| `search`    | Find services available to you.                               |
| `describe`  | Read a service's method signatures and documentation.         |
| `call`      | Call a service method.                                        |
| `execute`   | Combine several calls in a short JavaScript script.           |
| `skills`    | Read the `widefleet` skill for building and deploying apps.   |
| `cli_login` | Sign in the Widefleet CLI in the client's shell as your user. |

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
return up to 1 MiB of JSON. Calls that completed before an error keep their
effects, so check them before running a script again.

### Build apps

The `widefleet` skill teaches the client to create and deploy apps with the
[CLI](/reference/cli). Clients read it through the `skills` tool or as the
`skill://widefleet/SKILL.md` resource.

When the CLI has no session, for example in a new sandbox, the client calls
`cli_login` and runs the command it returns:

```sh
widefleet login --url https://app.widefleet.com --code CODE
```

The CLI signs in as you for the organization you connected, without opening a
browser. Each code works once and expires after two minutes.

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
- **Widefleet sign-in is unavailable:** open one of your organization's apps in
  the same browser and sign in, then choose **Check again**.
- **`cli_login` reports that no account matches:** sign in to Widefleet in your
  browser once, then ask the client to run `cli_login` again.
- **The client asks you to sign in again:** reconnect Widefleet in the client.

Next, [publish a service](/guides/app-services#publish-a-service) to make your
own app available to AI clients.
