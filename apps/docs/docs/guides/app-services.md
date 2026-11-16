---
title: Connect apps
description: Expose app APIs, connect callers and keep provider secrets private.
lastModified: 2026-11-16
---

An app can expose exported Worker entrypoints to other apps in its organization.
It uses the same deployment, resources, networking and logs as any other app.
Use a headless app when the service does not need browser access.

Install the current Widefleet platform, CLI and runtime together. Publishing
requires app creation or collaboration permissions. To connect a caller, you must
manage that app. The provider and caller must belong to the same organization.
Organization administrators decide whether each API needs approval.

## Publish a service

In a Worker project, create `src/worker.ts`:

```ts
import { WorkerEntrypoint } from "cloudflare:workers";

type Environment = {
  WIDEFLEET_SECRETS: { get(name: string): Promise<string> };
};

export class Reader extends WorkerEntrypoint<Environment> {
  async status() {
    const token = await this.env.WIDEFLEET_SECRETS.get("API_TOKEN");
    return { configured: token.length > 0 };
  }
}
```

Configure `wrangler.jsonc`:

```jsonc
{
  "name": "inventory-api",
  "main": "src/worker.ts",
  "compatibility_date": "2026-10-01",
}
```

Publish through the usual CLI. `--skip-build` uses the source entry directly;
the CLI still bundles it and discovers service entrypoints from the module exports.
Classes declared in the standard `workflows` configuration remain Workflow entrypoints.

```sh
widefleet deploy --skip-build
widefleet secret put API_TOKEN --file /secure/path/api-token
widefleet services
```

The secret file contains only the value. Keep it outside the project. The secret
command also accepts redirected standard input. `widefleet services` now lists
`inventory-api` and its `Reader` entrypoint; secret status should show matching
desired and applied revisions.

An app with only named service exports and no static assets has no browser launch
link and returns `404` for browser requests. Named service entrypoints still support
RPC and `fetch()`. A default export or configured static assets enables the app URL;
web apps can expose named service entrypoints alongside their browser UI.
No Widefleet-specific properties belong in `wrangler.jsonc`.

## Connect a caller

For an API available to everyone in the organization, an app owner or collaborator
runs the following from the caller's project. Organization administrators can
also connect APIs that require approval:

```sh
widefleet connect inventory-api --as INVENTORY --entrypoint Reader
widefleet connections
```

Use `--app CALLER` to select a caller by slug or UUID outside its project. The
target accepts a service catalog slug or UUID. Bindings default to the `default`
entrypoint; the provider must export a default Worker handler or `WorkerEntrypoint` class.

In the UI, open **App APIs** and choose **Set up connection** for the provider.
Choose an app you manage and continue to the connection settings. Select the API
entrypoint, enter a binding name and choose **Connect API**. The result page shows
whether the connection is saved, activating, active or needs attention.

Starting from the caller app's **Connections → Browse app APIs** keeps that app
selected and skips the app-selection step. The UI, CLI and API show the same
desired and active grants.

Call the binding from server-side app code:

```ts
type Environment = {
  INVENTORY: { status(): Promise<{ configured: boolean }> };
};

export default {
  async fetch(_request: Request, env: Environment) {
    return Response.json(await env.INVENTORY.status());
  },
};
```

Deploy the caller and request its authenticated app URL. The response is
`{"configured":true}`; the caller receives the result, not `API_TOKEN`.
Use the provider's own [network permissions](/guides/network) for outbound
requests to an external system. Each app keeps its own D1, R2 and KV resources.

## User identity

A request authenticated through company sign-in supplies `ctx.props.caller` to
the app's HTTP handler. App bindings carry that identity automatically across
RPC and `fetch()` calls, including calls through another service app:

```ts
import { WorkerEntrypoint } from "cloudflare:workers";

type Caller = { issuer: string; subject: string; name: string };

export class Profile extends WorkerEntrypoint<{}, { caller: Caller | null }> {
  whoAmI() {
    const caller = this.ctx.props.caller;
    if (!caller) throw new Error("A signed-in user is required");
    return { issuer: caller.issuer, subject: caller.subject };
  }
}
```

Use the pair `(issuer, subject)` as the stable user key. Names and email addresses
are display data. The trusted runtime verifies the caller at each app boundary;
request headers, method arguments and changes to the caller object cannot select
another user. Company login cookies and tokens stay outside app code.

Connections authorize the calling app to use the API. Services must additionally
validate arguments and enforce their own per-user permissions. Calls without an
authenticated HTTP invocation, such as cron, queues and workflows, have no verified
user; a service receives `caller: null`. Delegation expires after five minutes and
further service hops do not extend it. Start a new authenticated request for later
user actions; do not persist delegation proofs in jobs.

Apps with a browser UI can manage provider OAuth on their own HTTPS URL.
`env.WIDEFLEET_ORIGIN` contains that canonical origin. App cookies are forwarded,
but company sign-in cookies are filtered. App responses can set only host-scoped
cookies and cannot overwrite company sign-in cookies. Keep OAuth state, callback
user checks and CSRF protection in the app.

The [Gmail app example](/guides/gmail-app) connects each user's personal Google
account and shares that account across authorized calling apps.

## API availability and connection requests

APIs require administrator approval by default. An organization administrator can open the provider's
**View API documentation → Manage availability** page and select **Everyone in
this organization** to let app owners and collaborators connect their apps themselves.
This permission covers the provider's available entrypoints. It does not grant
management access to the provider or expose its secrets.

The equivalent CLI commands are:

```sh
widefleet services access inventory-api --mode organization
widefleet services access inventory-api --mode approval-required
```

Changing availability keeps existing connections. On the caller's **Connections**
page, expand a binding and choose **Disconnect**, or use
`widefleet disconnect INVENTORY --app CALLER` to remove a connection from a caller
you manage.

For a restricted API, choose **Set up connection** in the catalog and select the
caller app. Choose the entrypoint and an unused binding name, then choose
**Submit request**. The confirmation page shows the requested connection and
explains that the app has no access until an administrator approves it. From the CLI:

```sh
widefleet connect inventory-api --app CALLER --as INVENTORY --entrypoint Reader --request
widefleet services requests
```

Submitting the same pending request again returns the existing request. A binding
can have only one pending request. The request is for that caller, binding and
entrypoint; it does not authorize connections from other apps.

Open **App APIs → Connection requests** to see **Awaiting approval**, **Approved**
or **Rejected**. Members see their own requests; organization administrators see
all requests in the selected organization and can choose **Approve and connect**
or **Reject**. CLI administrators use:

```sh
widefleet services requests
widefleet services approve REQUEST_UUID
widefleet services reject REQUEST_UUID
```

Approval rechecks the requester's current app permissions, the available API and
the binding name before saving the connection. If these have changed, the request
stays pending and the administrator sees an error. After restoring access or
fixing the API, any organization administrator can retry approval. To change the
requested settings, reject the stale request and submit a new one.

**Approved** confirms the connection was saved, not that runtime activation has
finished. Check the caller's **Connections** page or `widefleet connections --app
CALLER` for activation status. A rejected request creates no connection; you can
submit another request if needed. Personal OAuth sign-in to an external service
remains separate from this approval.

## Activation and updates

Connections can be saved before the caller's first deployment. Otherwise the
CLI waits for activation unless `--no-wait` is set. **Saved**, **pending**,
**active** and **failed** describe grant activation independently of code updates.
Retry a failed change by submitting it again and inspect `widefleet connections`.
App owners and collaborators can retry an unchanged saved connection even when
its provider requires approval. On the caller's **Connections** page, expand the
binding and choose **Retry connection**, or repeat the original `widefleet connect`
command. Changing its target or entrypoint still requires permission, and a
removed connection cannot be restored using its old approval.

Each new call resolves the provider's active app version. Calls already running
retain their selected code and secret snapshot. A caller does not need to be
redeployed after a provider update. Code rollback preserves current connection
grants and desired secrets. Previews start without inherited connections or secrets.

Widefleet rejects cross-organization grants and connection cycles. Disconnect
consumers and wait for activation before removing an entrypoint or deleting its app:

```sh
widefleet disconnect INVENTORY
widefleet connections
```

## Secrets

App collaborators manage secrets in the app's **Secrets** tab or through the CLI:

```sh
widefleet secret list
widefleet secret put API_TOKEN --file /secure/path/api-token
widefleet secret delete API_TOKEN
```

Names and activation status are readable; saved values are not. Values contain
1–5000 UTF-8 bytes. Variables and secrets together have a limit of 128 entries;
`WIDEFLEET_` names are reserved. App code reads secrets asynchronously through
`env.WIDEFLEET_SECRETS.get(NAME)`. Missing secrets reject the read.

A secret edit triggers a normal deployment using the latest accepted code
selection, or waits for the first deployment if no artifact exists. Confirm
activation before relying on the new value. Failed changes leave the previous
serving snapshot intact; repeat the edit to retry.

`widefleet secret list` returns names and activation status immediately. Secret
changes wait for activation unless `--no-wait` is set and report known activation
failures with a nonzero exit status. Resumed workflows use the current secrets
while retaining their pinned code version.

Back up PostgreSQL with its installation encryption key. Also preserve runtime
object storage and its encryption key. Hosted operators supply
`WIDEFLEET_SECRETS_KEY`, 32 random bytes encoded as 64 lowercase hexadecimal
characters, through their deployment configuration. Self-hosted runtimes persist
the generated key in their runtime state. Retained snapshots require that key.

## Runtime limits and troubleshooting

RPC supports transferable data values, including arrays, dates, maps, sets and
byte arrays. Callbacks, returned RPC objects and custom-RPC streams are outside
the shared contract. Use a `fetch()` handler for HTTP bodies; native buffering
and log coverage differ as described in [runtime compatibility](/reference/runtime-compatibility).
Dynamic apps cannot declare Durable Objects.

Use ordinary `widefleet logs --app APP` and app deployment history for service
errors. An unavailable service can indicate a removed deployment, a missing
entrypoint or organization suspension. Confirm the target is deployed, the grant
is active and the selected organization is correct. Hosted service calls use the
operator's [`service` execution budget](/reference/configuration#dynamic-worker-execution-limits).

## API

All routes use normal OAuth authentication and the selected organization.

| Action                                           | Route                                                                                                                                      |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Discover available apps and entrypoints          | `GET /api/v1/app-services`                                                                                                                 |
| Set API availability                             | `PUT /api/v1/app-services/{appId}/access` with `{ "accessMode": "organization" }` or `{ "accessMode": "approval_required" }`               |
| Request a connection                             | `POST /api/v1/connection-requests` with `{ "appId": "CALLER_UUID", "app": "TARGET_UUID", "binding": "INVENTORY", "entrypoint": "Reader" }` |
| List connection requests                         | `GET /api/v1/connection-requests`                                                                                                          |
| Approve and connect                              | `POST /api/v1/connection-requests/{requestId}/approve`                                                                                     |
| Reject a request                                 | `POST /api/v1/connection-requests/{requestId}/reject`                                                                                      |
| Inspect resources and active/desired connections | `GET /api/v1/apps/{appId}/connections`                                                                                                     |
| Inspect grants                                   | `GET /api/v1/apps/{appId}/bindings`                                                                                                        |
| Grant one binding                                | `PUT /api/v1/apps/{appId}/bindings/{binding}` with `{ "app": "TARGET_UUID", "entrypoint": "Reader" }`                                      |
| Revoke one binding                               | `DELETE /api/v1/apps/{appId}/bindings/{binding}`                                                                                           |
| List secret names and activation status          | `GET /api/v1/apps/{appId}/secrets`                                                                                                         |
| Set a secret                                     | `PUT /api/v1/apps/{appId}/secrets/{secret}` with `{ "value": "..." }`                                                                      |
| Delete a secret                                  | `DELETE /api/v1/apps/{appId}/secrets/{secret}`                                                                                             |

See the authenticated [OpenAPI document](/reference/api) for response schemas.
