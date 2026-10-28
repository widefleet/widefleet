---
title: IT connectors
description: Deploy Dynamic Worker integrations and grant apps access to their APIs.
lastModified: 2026-10-28
---

IT can deploy a Worker from its own repository with `widefleet connector deploy`. Apps receive a scoped binding and call its methods directly, for example `env.ERP.listCustomers()`. Connector code runs as a Dynamic Worker with its own declared resources on both self-hosted celld and Cloudflare. After installation, connector code and secret updates activate independently of platform releases.

Use matching platform, CLI and app runtime **0.4.2 or newer**.

## Find connectors and inspect your app

Use CLI and control-plane version 0.3.3 or newer for connector discovery and app
connection views.

Sign in to Widefleet and open **Connectors** to browse the integrations offered by your organization. Members can search connector names and expand a connector to see its available entrypoints. **Available** means an administrator can assign an entrypoint; it does not grant your app access. **Not ready** means activation must complete before the connector can be assigned.

From the CLI:

```sh
widefleet connector catalog
widefleet connections --app inventory
```

In an app project with `name` in `wrangler.jsonc`, run `widefleet connections` without `--app`. Use `--config PATH` for another project configuration and `--json` for structured output. Redirected stdout also uses JSON. These commands need `platform:read`, included in ordinary `widefleet login`.

To inspect an app in the UI, open its **Connections** tab. The view connects the app's domain to the app, then shows its connector bindings and resources. Expand a binding for its target, entrypoint where applicable, and name in code, such as `env.ERP`. **Browse connectors** opens the catalog with the app's existing connections indicated. App owners, administrators and app collaborators can inspect connections; catalog visibility alone does not grant app management access.

Resources come from the active deployment, including database, object storage, key-value storage, queue, workflow and static asset bindings. A failed or pending deployment does not replace this list. Variable values and connector secrets are not included.

D1 bindings show the database name and the selected database ID. The ID comes from `database_id` in the deployment configuration, falling back to `database_name` when no ID is set. In CLI and API JSON, `target` retains the name and `databaseId` identifies the selected database, so databases with the same name remain distinguishable.

Connector changes have a separate activation state:

| State   | Meaning and next step                                                                                 |
| ------- | ----------------------------------------------------------------------------------------------------- |
| Saved   | The binding is configured before the app's first deployment. Deploy the app to activate it.           |
| Pending | Activation is queued or running. Previously active bindings remain in use. Refresh to check progress. |
| Active  | The binding is active for the app. Use its binding name in code.                                      |
| Failed  | The change did not activate. Inspect the error and ask an administrator to retry the binding change.  |

A pending or failed removal remains visible with its currently active connector. If the serving bindings cannot be confirmed, the view says so rather than treating saved bindings as active. In CLI JSON, `connectors` contains the desired bindings and activation state; `activeConnectors` contains the confirmed serving bindings, or `null` when unavailable. `resources` contains the active deployment's resources and `deploymentId` identifies that deployment.

After choosing a connector, ask an administrator to [give the app its binding](#give-an-app-its-binding). The connector author supplies the corresponding TypeScript interface or package.

Each connector has one browser address, exposed as `browserUrl` in status and
catalog responses. Expand an activated connector in the catalog to open its
**Browser address**, or inspect it with `widefleet connector catalog --json`.
Administrative status from `widefleet connector show NAME --json` includes the
address while activation is pending; the catalog returns `null` until a version
has activated.

## Manage connectors in an organization

Organization-scoped management and browser forms require platform and CLI
**0.4.0 or newer**.

An owner or administrator of the selected organization can deploy and update its
connectors, set and remove connector secrets, assign app bindings and read
connector logs. Members can browse the catalog and inspect apps they can access.
Installation settings, runtime upgrades and deployment-agent administration remain
operator responsibilities.

Connector names are unique within an organization. Two organizations may
both deploy `erp`; their code, secrets, activation jobs and app bindings remain
separate. Select the organization in the workspace header or use
[CLI organization selection](/reference/cli-configuration#select-an-organization):

```sh
widefleet --organization ORGANIZATION_ID connector list
widefleet --organization ORGANIZATION_ID connector deploy
```

For API calls, send `X-Widefleet-Organization` as described in
[request context](/reference/api#organization-context). The same membership and
role checks apply to browser, CLI and API operations, including direct app IDs.

### Manage a connector in the browser

Deploy or update connectors from their source projects with the
[CLI deployment workflow](#deploy-from-a-project). The browser manages existing
connectors:

1. Open **Connectors** in the selected organization and choose **Manage connector**
   for the connector you want to inspect.
2. Use **Refresh status** to check activation or **View logs** to inspect runtime
   output.
3. Under **Secrets**, add or replace a value, or remove an existing name. Values
   are never returned by status queries or failed form responses. Secret values
   are limited to 5000 UTF-8 bytes.

To assign a connector, open an app’s **Connections** tab, then **Browse
connectors**. Under **Add or replace a connection**, choose the connector, enter
an available entrypoint and a binding name, and select **Save connection**.
**Disconnect** removes a saved binding. The app’s connection view distinguishes
saved changes from currently active bindings.

Deployments, secret changes and changes to active app bindings activate
asynchronously. A submitted change is not confirmation that the new version is
serving. On failure, inspect the status or logs and retry; the previous serving
configuration remains active. There is no operation to delete a connector itself.

If another tab changes the selected organization, an old form is rejected before
writing. Reload the page and check the organization before trying again.

## Deploy from a project

Use the normal Widefleet login. Deployment and binding changes require a current owner/admin role and `platform:write`; status commands need `platform:read`. Both scopes are requested by ordinary `widefleet login`. The same token works in CI through `PLATFORM_ACCESS_TOKEN`.

Create `wrangler.jsonc`:

```json
{
  "name": "erp",
  "main": "worker.ts",
  "compatibility_date": "2026-10-01"
}
```

Create `worker.ts`:

```ts
import { WorkerEntrypoint } from "cloudflare:workers";

export default class ERP extends WorkerEntrypoint {
  async listCustomers() {
    return [{ id: "example", name: "Example customer" }];
  }
}
```

```sh
widefleet connector deploy
widefleet connector list
widefleet connector show erp
```

The CLI bundles TypeScript/JavaScript and installed dependencies, discovers exported entrypoints, uploads the code and private source maps, and waits for activation. `--config PATH` selects another Wrangler file; `--no-wait` returns after queuing. Build progress uses stderr; `--json` or redirected stdout returns structured results. Run any project-specific code generation before deployment.

The CLI retries temporary upload failures automatically. Run the command again to retry a failed activation. To restore previous code, deploy the previous source checkout; existing data is retained. A newer concurrent deployment is reported explicitly if it supersedes a waiting command.

## Connector secrets

After deploying the connector, an owner/admin can set its secrets without uploading code again:

```sh
widefleet connector secret put erp ERP_API_KEY --file /private/erp-api-key
widefleet connector secret put erp ERP_API_KEY < /private/erp-api-key
widefleet connector secret list erp
widefleet connector secret delete erp ERP_API_KEY
```

Values are accepted only through a file or redirected stdin, never a command-line argument. Input is preserved exactly, including trailing newlines; use a file without a final newline when the credential requires it. Secret values must contain 1–5000 UTF-8 bytes. Variables and secrets together are limited to 128 names. `put` and `delete` wait for activation; `--no-wait` returns after queuing. Listing returns names and activation status, never values. These operations use the same administrator permissions and ordinary login as connector deployment.

The platform supplies an asynchronous `WIDEFLEET_SECRETS` binding only to that connector:

```ts
import { WorkerEntrypoint } from "cloudflare:workers";

interface Env {
  WIDEFLEET_SECRETS: { get(name: string): Promise<string> };
}

export default class ERP extends WorkerEntrypoint<Env> {
  async listCustomers() {
    const secrets = this.env.WIDEFLEET_SECRETS;
    const apiKey = await secrets.get("ERP_API_KEY");
    const response = await fetch("https://erp.example.com/customers", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    return response.json();
  }
}
```

Missing secrets reject the promise. Secret names are case-sensitive and follow binding-name syntax. The prefix `WIDEFLEET_` and the name `__proto__` are reserved. Ordinary `vars` remain separate; a same-named variable does not satisfy a secret lookup. Keep secret values out of business responses and logs. For local Wrangler tests, supply a test implementation of the binding; Widefleet provides it during activation.

Secret changes apply with the connector's currently desired code. Check `widefleet connector show NAME` to confirm activation. If activation fails, retry by setting the secret again or redeploying the desired source. Code rollback preserves the latest desired secrets. Requests already in flight may finish with the previous code and secrets.

### Storage and recovery

Restore PostgreSQL together with the installation encryption key to recover saved connector secrets. For self-hosted installations, also back up the full fleet object storage and persistent runtime state, including the automatically generated connector encryption key.

Hosted deployments require `WIDEFLEET_CONNECTOR_KEY` as a runtime Worker secret through the deployment configuration. Generate 32 random bytes encoded as 64 lowercase hexadecimal characters, for example with `openssl rand -hex 32`. Preserve that key across deployments and with the runtime storage backup; retained connector snapshots require their original key for recovery.

## Connector logs

Owners and administrators can open **Connectors → expand a connector → View logs** to inspect runtime output, search messages and filter by severity, time and connector version. CLI users can read or follow the same records:

```sh
widefleet logs --connector erp --since 1h
widefleet logs --connector erp --level error --follow
widefleet logs --connector erp --version VERSION_ID --json
```

Connector logs use the existing runtime logging backend: Workers Logs on hosted Cloudflare and the [Collector/ClickHouse pipeline](/self-hosting/runtime-logs) on self-hosted installations. Enable that pipeline before querying self-hosted logs. If it is unavailable, the UI and API report the configuration problem; invocation results do not depend on successful log delivery.

The UI, CLI and API show original source locations when the deployed package includes a matching source map. Otherwise, they show the generated stack. Use the version filter to inspect errors from an earlier deployment.

On celld 0.6.2, connector logs cover HTTP `fetch()` calls and their `waitUntil` work. RPC and Durable Object calls are not captured, and rejected HTTP calls may also be missing. Use caller-side error handling for those failures. See [runtime compatibility](/reference/runtime-compatibility) for runtime differences.

Log delivery is best-effort; outages and runtime termination can lose records. Keep credentials and unnecessary personal data out of console output. Confirm capture by invoking a connector HTTP endpoint, then refreshing **View logs** or running the CLI command above.

## Give an app its binding

From the app project, or by selecting its name:

```sh
widefleet connector bind erp --as ERP
widefleet connector bindings
widefleet connector bind erp --as ERP --app inventory
widefleet connector unbind ERP --app inventory
```

These commands resolve the existing app from `wrangler.jsonc` or `--app NAME`. They change one binding without replacing unrelated grants. The app can then call:

```ts
const customers = await env.ERP.listCustomers();
```

The binding grants the selected entrypoint's callable RPC methods and `fetch()` handler. To expose a narrower API, the connector author exports a separate `WorkerEntrypoint` class and IT selects it with `--entrypoint CustomerReader`. The IT project supplies the corresponding TypeScript interface or type package to app projects.

RPC arguments and results use transferable values, including ordinary data objects, dates, byte arrays, maps and sets. Callbacks, returned RPC objects and streams passed through custom RPC are outside the common connector contract. For large exports, expose a `fetch()` handler and consume its response body as a stream. A remote session can instead be represented by an ID passed to subsequent methods. Instance fields and platform lifecycle methods are not callable RPC methods.

Bindings default to the connector's `default` export. A connector package must include a default Worker export even when callers select a named entrypoint. Export a `WorkerEntrypoint` class as default, or supply a default fetch handler alongside named entrypoints. Exported Durable Object classes are excluded from the CLI's entrypoint list.

A binding can be saved before the app's first deployment. Otherwise changes wait for activation, unless `--no-wait` is used. Status distinguishes saved, pending, active and failed; repeating a failed change retries it. A failed code deployment does not mark already active grants as failed. Previews start without connector grants, and app code rollback keeps current bindings. Resource-name collisions and reserved `WIDEFLEET_` names are rejected.

## User identity and connector pages

Connectors can implement account linking, setup pages and other interactive
flows. Widefleet supplies the verified caller and a separate browser origin;
the connector implements its routes, provider authorization, token storage,
refresh and account management. An app uses the connector's documented API and
links. Widefleet does not automatically display an account-connection dialog.

Use matching control-plane, CLI, deployment-agent and app-runtime versions when
enabling browser pages. Configure [published app sign-in](/guides/members#opening-published-apps)
for the organization first.

### Identify the caller

For calls made while handling an authenticated app request, a connector
`WorkerEntrypoint` receives `this.ctx.props.caller` with:

| Field     | Use                                            |
| --------- | ---------------------------------------------- |
| `issuer`  | Identity provider that authenticated the user. |
| `subject` | User ID within that identity provider.         |
| `name`    | Display name; not a stable account identifier. |

Use the pair `(issuer, subject)` to associate a user's stored connections with
their identity. Resources are already scoped to the connector's organization.
App code calls the ordinary binding, such as `env.ERP.listCustomers()`; it does
not supply the caller or need an identity SDK. The runtime verifies caller
context before passing it to the connector. Calls without an authenticated
request context, including scheduled work, receive `caller: null`. The connector
must decide whether such a call is allowed and which shared credentials it may
use. The forwarded request headers are not a substitute for `ctx.props.caller`.

Storing one connection per identity allows multiple apps using this connector to
reuse it. Multiple accounts and account selection are connector behavior, not
platform-managed settings. Keep tokens in the connector's own persistent
resources and out of RPC results, browser responses and logs.

### Implement connector pages

Every deployed connector has a browser address. Browser requests call the
`fetch()` handler of its default export; no additional configuration is needed.
Implement paths such as `/connect` and `/callback` in that handler.

This complete `worker.ts` exposes the caller identity for verification:

```ts
import { WorkerEntrypoint } from "cloudflare:workers";

interface Env {
  WIDEFLEET_ORIGIN: string;
}

interface Props {
  caller: { issuer: string; subject: string; name: string } | null;
}

export default class ERP extends WorkerEntrypoint<Env, Props> {
  fetch() {
    if (!this.ctx.props.caller) return new Response("Sign-in required", { status: 401 });
    return Response.json({ caller: this.ctx.props.caller, origin: this.env.WIDEFLEET_ORIGIN });
  }
}
```

Deploy it with `widefleet connector deploy`, then inspect
`widefleet connector show erp`. After activation succeeds, open the
browser address and sign in. The response shows your verified identity and the
connector's origin. Replace the verification handler with your connector's
pages and provider flow before using it for account connections.

Each organization and connector name has one HTTPS origin under the
installation's app domain. Connector updates and new app bindings keep that
origin unchanged. Renaming the connector or changing the installation domain
changes the address. `env.WIDEFLEET_ORIGIN` supplies the origin to connector code;
register provider callbacks using that origin and your callback path. Adding an
app binding does not require another provider callback registration.

All paths at this address reach the default export's `fetch()` handler unchanged.
Named RPC entrypoints remain available through app bindings; they do not create
separate browser routes. A connector without a default `fetch()` implementation
cannot serve pages at its address.

### Link from an app

Find the app's binding name with `widefleet connections` or the app's
**Connections** tab. If the connector documents a `/connect` page and the binding
is `ERP`, the app can render:

```html
<a href="/_widefleet/connectors/ERP/connect">Connect your account</a>
```

Widefleet checks the app's access rules and active binding, then redirects the
browser to the connector's fixed address. The suffix and query string are
preserved. This always reaches the default `fetch()` handler, including when
the app binding selects a named RPC entrypoint. This entry link accepts `GET`
and `HEAD`; forms and provider callbacks must target the canonical connector address. `/connect` is a route chosen by
the connector author, not a platform-defined endpoint.

Users can also open the canonical address directly, before any app has a binding.
Access requires sign-in accepted by that organization's configuration; app group
rules do not apply there. With company SSO, the IdP registration controls who
can authenticate. This does not add a separate control-plane membership check.
Other organizations' sessions do not grant access. Connector pages must enforce
their own account ownership and action permissions.

### Browser boundaries and recovery

Connector pages have a different origin from apps. Widefleet removes browser
CORS grants from connector responses, applies its Content Security Policy and
retains any stricter connector policy. Serve scripts and assets from the
connector's own origin: external scripts, cross-origin browser API requests,
frames and service workers are blocked. Start provider authorization with a
top-level navigation; server-side provider requests are independent of this CSP.

The connector receives its own browser cookies, but never the platform's company
sign-in cookies. Widefleet strips `Domain` from response cookies so they remain
host-only and prevents replacement of company sign-in cookies. The connector
still needs CSRF protection, secure OAuth state validation and validation of any
return URL it accepts. Separate origins and CORS restrictions do not prevent all
cross-origin requests.

| Symptom                                                    | Check                                                                                           |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Browser redirects to sign-in; an API request returns `401` | Establish the organization's sign-in session in the browser.                                    |
| The app entry link returns `403`                           | Check the user's access to that app. Direct connector access uses organization sign-in instead. |
| Page or entry link returns `404`                           | Confirm activation, the route path and, for an app link, the active binding.                    |
| The app entry link returns `405`                           | Navigate with `GET`; submit forms to the canonical connector address.                           |

Once the verification page works, implement the account flow in the connector
and [give apps their bindings](#give-an-app-its-binding). Use the published
canonical address for provider callbacks and the relative binding link for app
navigation.

## Resources and activation

Connector configuration supports `vars`, D1, R2, KV and local Durable Object bindings. A connector supports up to 32 ordinary bindings, including variables and storage bindings; each variable value is limited to 16,384 characters. Resources belong to the connector, independently of similarly named app resources or another connector's resources. Its outbound networking is independent of the app's network allowlist; connector code must enforce its own business restrictions.

An optional Wrangler `database_id` selects D1's logical identity, falling back to `database_name`. Widefleet scopes that identity to the connector and provisions the resource.

Implement state in a `DurableObject` and declare its class in `durable_objects.bindings`. Widefleet hosts each object as a persistent facet behind a shared runtime Durable Object. Connector classes do not need native class migrations; the CLI removes Wrangler `migrations` from the published package, so a project can retain them for local native development.

Keep the organization, connector, class name and object ID stable to preserve state across deployments. Different connectors can use the same class name without sharing data. Within one connector, bindings to the same class share its namespace. Address the same object deliberately, for example `env.STATE.getByName("erp-connection")`. Object IDs are opaque platform identifiers; use `idFromString()` to restore a saved ID. Renaming a connector or class creates a different namespace and does not migrate stored data.

Connector objects support SQLite and key-value storage, RPC and `fetch()`. Active calls, response streams and `waitUntil` work finish before an object switches code versions. Storage alarms and WebSockets are outside the connector contract; see [runtime compatibility](/reference/runtime-compatibility).

Connector code and secret updates prepare an immutable version, check readiness and switch the active version. They do not require a native Worker deployment or a celld reload. Adding or changing native resources can still update shared runtime configuration. New calls from every bound app resolve the active connector version; existing calls retain their selected code and secret snapshot. An object that has already advanced to a newer version rejects requests from an older version instead of downgrading its state handler.

If activation fails, check `widefleet connector show NAME` to inspect the serving version and error, then retry the deployment. Before removing an entrypoint, disconnect its app bindings and confirm that those changes have activated.

Installed code, configuration, bindings and state remain in the data plane. Serving apps and ordinary runtime restarts work without the control plane or deployment agent. App deletion removes that app's references, not a shared connector or its data.

`vars` are ordinary package configuration; use the dedicated secret commands for credentials. Connector cron/queue configuration, cross-organization bindings and connector removal commands are not implemented here. Runtime updates preserve installed connectors. Native RPC/DO/telemetry differences are described in the [celld compatibility notes](/reference/runtime-compatibility).

## API

The OpenAPI document includes connector artifact schemas and normal OAuth authentication:

| Operation                                                         | Endpoint                                                                                              |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Browse connector names and grantable entrypoints                  | `GET /api/v1/connector-catalog`                                                                       |
| Inspect app resources and desired / active connector bindings     | `GET /api/v1/apps/{appId}/connections`                                                                |
| Read connector logs with time, severity, text and version filters | `GET /api/v1/connectors/{name}/logs`                                                                  |
| List / inspect connector deployments                              | `GET /api/v1/connectors`, `GET /api/v1/connectors/{name}`                                             |
| List secret names and activation status                           | `GET /api/v1/connectors/{name}/secrets`                                                               |
| Set / delete a connector secret                                   | `PUT /api/v1/connectors/{name}/secrets/{secret}` with `{ "value": "..." }`, `DELETE` at the same path |
| Upload and deploy the bundled project                             | `PUT /api/v1/connectors/{name}`                                                                       |
| Read app bindings and activation state                            | `GET /api/v1/apps/{appId}/bindings`                                                                   |
| Set one binding                                                   | `PUT /api/v1/apps/{appId}/bindings/{binding}` with `{ "connector": "erp", "entrypoint": "default" }`  |
| Remove one binding                                                | `DELETE /api/v1/apps/{appId}/bindings/{binding}`                                                      |

Binding updates are atomic and do not require a caller-supplied revision. Connector deployment, administrative status listing and grant changes require administrator access. Members can browse the connector catalog; app collaborators can read their app's connections and bindings. CLI users select names and project context; IDs remain API identifiers.

Use [`widefleet connector deploy`](#deploy-from-a-project) to build and deploy a connector from its source project. For custom integrations, the authenticated [OpenAPI document](/reference/api) describes the upload contract and deployment status.
