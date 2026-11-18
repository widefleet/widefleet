---
title: Connect AI clients with MCP
description: Discover and call app services from an AI client using your existing app access rules.
lastModified: 2026-11-18
---

Connect an MCP client to Widefleet to discover and call the app services available
to your account. The gateway uses the services' existing entrypoints and method
documentation and the same company-group rules as browser access to each app.

MCP support is included in Widefleet **0.7.6**. Use matching control-plane,
app-runtime, agent and CLI releases. Native installations require the packaged celld `0.6.3-widefleet.1` runtime. Your client
must support remote HTTP MCP and OAuth authorization with PKCE.

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
app access rules determine which services are available; administrator status
alone does not bypass an app's group restriction.

The gateway exposes app services and a skill that guides app creation and deployment
through the CLI. Read it with `skills({"name":"widefleet"})` or the MCP resource
`skill://widefleet/SKILL.md`. The service tools themselves do not create, change or
deploy apps. Use Widefleet's UI, API or CLI for platform administration.

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
uses Google groups for app access, its login requests the Cloud Identity groups permission after
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

## Choose who can use an app's services

Open the app in management and choose **Access → App access**. These are the
same rules used when someone opens the app in a browser:

- An empty group list allows everyone admitted by the organization's sign-in.
- A group list requires membership in at least one listed company group.

App owners and organization administrators can edit these rules. They apply to
all published service entrypoints and methods, including methods that write data.
There is no separate MCP permission list or per-entrypoint grant. Restrict app
access before exposing services that should only be available to a specific group.

Use the existing CLI to inspect or replace the rules:

```sh
widefleet access show --app inventory
widefleet access set --app inventory --group warehouse-readers
```

[App access](/reference/app-access) covers group IDs, activation, previews and the
API. App-to-app connections continue to use their existing service approvals;
those approvals do not determine a person's MCP access.

## Discover and call services

The gateway exposes five tools:

| Tool       | Purpose                                                     |
| ---------- | ----------------------------------------------------------- |
| `skills`   | List skills, or read the Widefleet skill by name.           |
| `search`   | Find service entrypoints available to your account.         |
| `describe` | Read an entrypoint's published method documentation.        |
| `call`     | Invoke a documented service method.                         |
| `execute`  | Combine service calls in a confined JavaScript interpreter. |

Use `search` with an optional `query`, following its `cursor` until it is `null`.
Search results include short documentation excerpts; the query searches the full
summary. Pass a returned `hostname` and `entrypoint` to `describe` for full
signatures and documentation. Descriptions come from
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

The interpreter exposes `tools.call` for service methods. Each subcall checks the
token and the target app's current published group rules. The script cannot access
platform credentials or the host environment, and direct network access is
unavailable. A called service retains its own configured external-network permissions.

Code mode supports a JavaScript subset, including async calls, loops and data
transformations. It does not expose arbitrary imports, Node APIs, timers or
`fetch`. Unsupported syntax returns an execution error. Scripts run inside the
existing gateway; they do not create a Dynamic Worker for each execution. Normal
runtime execution charges and the services' existing workers still apply.

A script is limited to 32 service calls, 30 seconds elapsed execution and a 1 MiB
JSON result. The interpreter has no separate per-script CPU or memory isolation;
the gateway's runtime limits also apply. The code itself is limited to 32,768 characters.
MCP request bodies and individual interpreted service-call inputs are limited to 1 MiB.
Completed calls are not rolled back after a later failure or cancellation. Inspect
any completed effects before retrying; Widefleet does not replay a failed script.

## Token renewal and availability

The data plane owns MCP authorization codes, client registrations, grants and
tokens in its KV store. It verifies service permissions and executes calls there.
Access tokens last at most five minutes and never outlive the verified company
identity. Refreshing a token refreshes the upstream authorization and identity,
including the company groups used for app access. If the provider no longer permits
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
Changing an app's groups restricts both browser and MCP access once the updated
configuration is active.

If a service is missing, check the connected organization, app group rules and
active deployment. If `describe` has no method signatures for an existing service,
redeploy it with the current CLI, management and agent releases. Deployment publishes
the documentation alongside that service artifact; MCP reads the documentation for
the active artifact, including after a rollback. For pending access changes, check
the deployment agent and the activation error under **Access → App access**.
If sign-in fails, verify the registered callback addresses, published login
configuration and provider permissions. A temporary publication failure during
native startup is logged and leaves management available; save the sign-in
settings again after restoring the runtime connection.

Discover a service and call a documented method to verify the complete connection.
