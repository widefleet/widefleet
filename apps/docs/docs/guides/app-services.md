---
title: Connect apps
description: Expose app APIs, connect callers and keep provider secrets private.
lastModified: 2026-11-18
---

An app can expose exported Worker entrypoints to other apps in its organization.
It uses the same deployment, resources, networking and logs as any other app.
Use a headless app when the service does not need browser access.

Use Widefleet platform, CLI and runtime **0.7.1 or newer**. Publishing requires app
creation or collaboration permissions. To connect a caller, you must
manage that app. The provider and caller must belong to the same organization.
Organization administrators decide whether each API needs approval.

People can also call published services from AI clients through [MCP](/guides/mcp).

## Publish a service

In a Worker project, create `src/worker.ts`:

````ts
import { WorkerEntrypoint } from "cloudflare:workers";

type Environment = {
  WIDEFLEET_SECRETS: { get(name: string): Promise<string> };
};

export class Reader extends WorkerEntrypoint<Environment> {
  /**
   * Check whether this provider has an API token.
   * @returns An object with `configured` set to true for a non-empty token.
   * @throws If `API_TOKEN` has not been set.
   * @example
   * ```ts
   * const status = await env.INVENTORY.status();
   * ```
   */
  async status() {
    const token = await this.env.WIDEFLEET_SECRETS.get("API_TOKEN");
    return { configured: token.length > 0 };
  }
}
````

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
**App APIs** and `widefleet services` list named entrypoints. They list a default export
when it has RPC methods or a TSDoc comment. A default export with only an undocumented
`fetch()` handler serves the app itself and is not listed; `widefleet connect` can still
bind it explicitly. To publish an HTTP API, describe it in a TSDoc comment on the default
export or export it as a named `WorkerEntrypoint`.
No Widefleet-specific properties belong in `wrangler.jsonc`.

## Document service methods

Add TSDoc comments to your exported `WorkerEntrypoint` classes and methods so
callers and agents can understand how to use the API. Widefleet publishes the
comments and TypeScript parameter and return types when you deploy the app.
The `status()` example above includes a return description and a usage example.

Start with a short description of what the method does. Add details as needed:

| Tag                         | What to describe                                      |
| --------------------------- | ----------------------------------------------------- |
| `@param name - Description` | What an argument means and which values are accepted. |
| `@returns`                  | What the caller receives.                             |
| `@throws`                   | When the call can fail.                               |
| `@example`                  | A call using the binding, in a fenced code block.     |
| `@remarks`                  | Additional usage requirements.                        |
| `@deprecated`               | What callers should use instead.                      |

Keep types in TypeScript signatures. You can also document interfaces and their
properties to explain the data your API accepts and returns.

After deploying, open **App APIs**, then **View API documentation** on the
provider app. To read the same information as JSON, run:

```sh
widefleet services describe inventory-api
```

The command accepts an app slug or UUID. The response includes methods, parameter
and return types, descriptions and examples from the active deployment. Redeploy
after editing comments; rolling back the app also restores its API documentation.

## Connect a caller

For an API available to everyone in the organization, an app owner or collaborator
runs the following from the caller's project. Organization administrators can
also connect APIs that require approval:

```sh
widefleet connect inventory-api --as INVENTORY --entrypoint Reader
widefleet connections
```

Use `--app CALLER` to select a caller by slug or UUID outside its project. The
target accepts an app slug or UUID, including apps that the catalog does not list. Bindings default to the `default`
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

Find ready-made integrations in [App templates](/guides/app-templates), then
connect the deployed app using the same flow.

## Ask the user before continuing

A service method can ask the person behind a call to confirm an action or fill in
a short form, then continue with the answer. Requires an app runtime released
after 0.7.7.

Return the question instead of a result. `requestState` holds values the method
needs again, such as text the person is about to approve:

```ts
import { WorkerEntrypoint } from "cloudflare:workers";

type Answer = { action: "accept" | "decline" | "cancel"; content?: { note?: string } };
type Input = { inputResponses: { confirm?: Answer }; requestState: { text: string } };

export class Offers extends WorkerEntrypoint<Env, { input?: Input }> {
  async send(offerId: string) {
    const input = this.ctx.props.input;

    if (!input) {
      const text = await this.writeOffer(offerId);
      return {
        resultType: "input_required",
        inputRequests: {
          confirm: {
            message: `Send this offer?\n\n${text}`,
            requestedSchema: { type: "object", properties: { note: { type: "string" } } },
          },
        },
        requestState: { text },
      };
    }

    if (input.inputResponses.confirm?.action !== "accept") return { sent: false };
    await this.deliver(offerId, input.requestState.text);
    return { sent: true };
  }
}
```

The method is called again with the same arguments, and `ctx.props.input` holds
the answers and the `requestState` it returned:

- [MCP clients](/guides/mcp) on protocol revision 2026-07-28 show each request as
  a form and send the answers back on their own.
- A calling app receives the question as the method's result, shows it in its own
  interface and sends the answers with `withInput`:

```ts
const result = await env.OFFERS.send(offerId);

if (result.resultType === "input_required") {
  // Show result.inputRequests, then call again with the answers:
  return env.OFFERS.withInput({ inputResponses, requestState: result.requestState }).send(offerId);
}
```

The calling app passes `requestState` back unchanged; Widefleet keeps its contents
private to the service. Answers reach only the same method with the same
arguments, for the same caller, within 24 hours, and accepted content matches the
requested form. Make the confirmed action idempotent, for example by recording
that the offer was sent, so a repeated answer has no second effect.

- A call asks up to 8 questions. Each form has up to 32 `string`, `number`,
  `integer` or `boolean` fields, the primitive subset of MCP form elicitation.
  Strings support `enum`, `format`, length limits and defaults.
- Questions take up to 16 KiB and `requestState` up to 8 KiB of JSON.
- `withInput` is reserved on app bindings, so it cannot be a service method name.

## API availability and connection requests

APIs require administrator approval by default. An organization administrator can open the provider's
**View API documentation → Manage availability** page and select **Everyone in
this organization** to let app owners and collaborators connect their apps themselves.
This setting covers connections to the provider's available entrypoints.
Provider management permissions stay unchanged.

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

Approval applies to the selected app, binding and entrypoint. Submitting the same
pending request again returns the existing request. Each binding has at most one
pending request.

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

**Approved** confirms the connection was saved. Wait for **Active** on the caller's
**Connections** page or check `widefleet connections --app CALLER` before using the
API. You can submit another request after a rejection. Personal OAuth sign-in to an
external service remains separate from this approval.

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

### Missing API documentation

Redeploy the app to publish its API documentation. If documentation is still
missing, check the deploy command's warnings for missing source files or
documentation that is too large to publish.

For custom builds, enable source maps with embedded source content and keep each
map at the location referenced by the generated Worker's `sourceMappingURL`.
The supplied starters already preserve these maps. If parameter or return types
are incomplete, check the project's TypeScript configuration and installed
dependencies.

## API

All routes use normal OAuth authentication and the selected organization.

| Action                                           | Route                                                                                                                                      |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Discover available apps and entrypoints          | `GET /api/v1/app-services`                                                                                                                 |
| Read an active API description                   | `GET /api/v1/app-services/{slugOrAppId}`                                                                                                   |
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
