---
title: Connect AI clients with MCP
description: Discover and call app services from an AI client using your existing service permissions.
lastModified: 2026-11-17
---

Connect an MCP client to Widefleet to discover and call the app services available
to your account. The gateway uses the services' existing entrypoints and method
documentation, with user and company-group grants.

Use matching control-plane, app-runtime, agent and CLI releases. Native
installations require the packaged celld `0.6.3-widefleet.1` runtime. Your client
must support remote HTTP MCP and OAuth authorization with PKCE. Local workerd
development processes do not enforce the CPU budget used by code mode.

## Connect

Register this server address in your MCP client, replacing the example app domain:

```text
https://mcp.apps.example.com/mcp
```

All organizations on the installation share this address. The client opens the
Widefleet connection page, which identifies the client and its return address.
Choose Google or Microsoft to sign in with your company account. If that account
matches several organizations, select the organization to connect to. Only
organizations matching the verified company identity are offered.

If your organization uses Widefleet sign-in or another company identity provider,
choose **Continue with Widefleet**. This uses the normal Widefleet login and
organization context, then completes the organization's existing app sign-in.
A valid app session can also offer **Continue as …**; Widefleet obtains a separate
OAuth grant for the MCP client rather than reusing the app's refresh token.

After sign-in, the client exchanges its authorization code and can discover your
services. The `mcp:services` scope covers service discovery and calls. The account's
current service grants determine which entrypoints are available; administrator
status alone does not grant access to a restricted service.

The gateway exposes app services. Use Widefleet's UI, API or CLI for platform
administration.

## Configure the installation

The `mcp` hostname belongs to the data plane and uses the installation's app
wildcard DNS and certificate. Apply the matching edge and runtime configuration
when upgrading. The app names `auth` and `mcp` are reserved; move an existing app
using either hostname before upgrading.

The normal app sign-in configuration publication also configures MCP. OAuth state
uses the existing data-plane KV store alongside app sign-in configuration. There
is no separate MCP activation step or additional database to provision.

For the common Google and Microsoft buttons, use the installation's existing
`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` and
`MICROSOFT_CLIENT_ID` / `MICROSOFT_CLIENT_SECRET` registrations. Add these exact
redirect URIs to the corresponding registrations, replacing the example domain:

```text
https://mcp.apps.example.com/oauth/callback/google
https://mcp.apps.example.com/oauth/callback/microsoft
```

Google sign-in accepts configured Google Workspace identities. If an organization
uses group grants, its login requests the Cloud Identity groups permission after
identifying the organization. The OAuth registration and company policy must
permit that access.

The shared Microsoft registration must allow organizational accounts from the
configured tenants. Configure the group claims and permissions needed by the
organization's existing Entra identity mapping. The common Microsoft button uses
the public Microsoft authority. Organizations using another authority can connect
through **Continue with Widefleet** and their configured app sign-in.

The Widefleet fallback and existing app-session path retain the organization's
registered `https://auth.APP_DOMAIN/oauth2/ORGANIZATION/callback` address. After
changing login credentials, publish the app sign-in configuration again through
the normal settings flow. [Sign-in configuration](/reference/social-sign-in) describes provider setup.

## Grant service access

An administrator opens **App APIs**, selects a service, and opens its availability
settings. **Everyone in this organization** makes its published entrypoints
available to organization members, including through MCP. This requires an
authenticated organization identity; it does not make the service public.

With **Administrator approval required**, add individual users or company groups
under **Users and groups**, selecting the entrypoint for each grant. Use the exact
identity-provider URL and user subject, or the exact company group ID. Personal
Widefleet accounts use the platform's `/api/auth` issuer and their Widefleet user
ID. Company accounts use the configured provider's issuer and subject. The same
service can grant `Reader` and `Writer` to different people.

The page distinguishes saved permissions from the revision active in the runtime.
Pending changes need the normal deployment agent or hosted activation process to
finish. Existing app-to-app grants remain separate from these user and group
grants. [App services](/guides/app-services) explains publishing entrypoints,
caller identity and private provider secrets.

To inspect user and group grants from the CLI:

```sh
widefleet services user-access inventory-api
```

To replace them, save the current revision and desired complete grant list in
`service-access.json`. For example, when the current revision is `2`:

```json
{
  "revision": 2,
  "grants": [
    {
      "entrypoint": "Reader",
      "users": [],
      "groups": ["warehouse-readers"]
    }
  ]
}
```

```sh
widefleet services user-access inventory-api --file service-access.json
```

Use your provider's real group ID. A revision conflict means another change was
saved; read the current grants and reconcile your changes before submitting again.
The response includes the saved revision, applied revision and activation state.

## Discover and call services

The gateway exposes four tools:

| Tool       | Purpose                                                 |
| ---------- | ------------------------------------------------------- |
| `search`   | Find service entrypoints available to your account.     |
| `describe` | Read an entrypoint's published method documentation.    |
| `call`     | Invoke a documented service method.                     |
| `execute`  | Combine service calls in an isolated JavaScript worker. |

Use `search` with an optional `query`, following its `cursor` until it is `null`.
Pass a returned `hostname` and `entrypoint` to `describe`. Descriptions come from
the active deployment; service authors do not need a separate MCP declaration.

For a service exposing `Reader.status()`, the `call` arguments are:

```json
{
  "hostname": "inventory.apps.example.com",
  "entrypoint": "Reader",
  "method": "status",
  "arguments": []
}
```

Use the hostname and method returned by discovery. Arguments are positional JSON
values and results must be JSON-compatible. Fetch handlers, streams and RPC
objects are not exposed through this interface. The service receives the caller's
identity and remains responsible for its own record-level permissions. Provider
credentials stay inside the service app.

## Combine calls with code mode

Send a JavaScript function body as the `execute` tool's `code` argument. For the
same example service:

```js
const status = await tools.call({
  hostname: "inventory.apps.example.com",
  entrypoint: "Reader",
  method: "status",
  arguments: [],
});
return { configured: status.configured };
```

The worker exposes `tools.call` for service methods. Each subcall checks the token
and current published service permissions. The script cannot access
platform credentials or the host environment, and direct network access is
blocked. A called service retains its own configured external-network permissions.

A script is limited to 32 service calls, one second of CPU, 30 seconds elapsed
execution and a 1 MiB JSON result. The code itself is limited to 32,768 characters.
MCP request bodies and individual code-mode call bodies are limited to 1 MiB.
Completed calls are not rolled back after a later failure or cancellation. Inspect
any completed effects before retrying; Widefleet does not replay a failed script.

## Token renewal and availability

The data plane owns MCP authorization codes, client registrations, grants and
tokens in its KV store. It verifies service permissions and executes calls there.
Access tokens last at most five minutes and never outlive the verified company
identity. Refreshing a token refreshes the upstream authorization and identity,
including the company groups used for grants. If the provider no longer permits
renewal, reconnect from your MCP client.

The configured common Google and Microsoft buttons and a valid app-session hint
let company sign-in start in the data plane without contacting the control plane.
Company authentication and token renewal contact the configured identity provider
directly. **Continue with Widefleet** needs the control plane to establish the
organization context. For organizations without company SSO, the control plane
also issues and renews the underlying app authorization.

Calls with valid tokens can continue during a control-plane outage while the data
plane and provider services remain available. Configuration changes still use
the control plane's normal publication path.

Clients can use the OAuth revocation endpoint advertised in the authorization
server metadata. Whether a client's disconnect button actually revokes a grant
depends on that client. KV-backed revocation and permission changes take effect as
they propagate; they are not guaranteed to become visible everywhere immediately.
Removing the account's service grants prevents further service access once the
updated configuration is active.

If a service is missing, check the connected organization, user or group grant and
active deployment. For pending permissions, check the deployment agent and the
activation error on the availability page. If sign-in fails, verify the registered
callback addresses, published login configuration and provider permissions.

## Service-grant administration API

These routes use normal platform API credentials and organization selection.
MCP resource tokens cannot be used as platform API tokens.

| Method and path under `/api/v1`         | Purpose                                                   |
| --------------------------------------- | --------------------------------------------------------- |
| `GET /app-services/{appId}/user-access` | Inspect user and group grants as an administrator.        |
| `PUT /app-services/{appId}/user-access` | Submit the current `revision` and complete `grants` list. |

Use the installation's [OpenAPI document](/reference/api) for the current schemas.
Discover a service and call a documented method to verify the complete connection.
