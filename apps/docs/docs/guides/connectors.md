---
title: IT connectors
description: Deploy Dynamic Worker integrations and grant apps access to their APIs.
lastModified: 2026-10-19
---

IT can deploy a Worker from its own repository with `widefleet connector deploy`. Apps receive a scoped binding and call its methods directly, for example `env.ERP.listCustomers()`. Connector code runs as a Dynamic Worker with its own declared resources on both self-hosted celld and Cloudflare. Once the supporting platform release is installed, connector code and secret updates activate independently of platform releases.

**Unreleased:** Dynamic connector activation requires matching control-plane, CLI, agent and app-runtime releases containing this implementation. The deployment, state and secret-storage behavior below describes that implementation, rather than the currently published releases.

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

Each artifact is immutable and identified by its content checksum. PostgreSQL stores references and deployment status; Object Storage stores code and configuration. Repeating an unchanged successful or pending deployment reuses it; repeating a failed deployment retries. To restore previous code, deploy the previous source checkout. This does not reverse data changes. A newer concurrent deployment is reported explicitly if it supersedes a waiting command.

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

Missing secrets reject the promise. Secret names are case-sensitive and follow binding-name syntax. The prefix `WIDEFLEET_` and the name `__proto__` are reserved. Ordinary `vars` remain separate; a same-named variable does not satisfy a secret lookup. The getter resolves secrets from the calling connector's immutable version through a platform-owned binding. Apps cannot obtain that binding through a connector grant. Trusted connector authors must keep secret values out of business responses and logs. For local Wrangler tests, supply a test implementation of the binding; Widefleet provides it during fleet activation.

Changes activate the connector's currently desired code and a fixed snapshot of its secrets. `secretRevision` and `appliedSecretRevision` distinguish the saved and confirmed serving configurations independently of the code checksum. A failed readiness check leaves the previous serving generation active. Retry by setting the secret again or redeploying the desired source; code rollback preserves the latest desired secrets. Requests already in flight may finish with the previous generation. Secrets belong to the connector, not to a particular app or user.

### Storage and recovery

Like apps, connector artifacts and runtime versions reference immutable modules stored by checksum. Code and private source maps use the same module validation and storage rules as apps: up to 32 runtime modules and 500 maps, with at most 20 MiB per file. Secret-only changes reuse those modules; each runtime version snapshot contains configuration, module references and encrypted secrets instead of another copy of the code. Source maps are excluded from executable runtime modules.

The control plane encrypts values using the installation encryption key and stores the ciphertexts in connector activation snapshots in PostgreSQL. Desired, applied and queued snapshots own their secret values independently of login settings and credential cleanup. Source artifacts contain no managed secret values. The active deployment agent, or the hosted deployment operation on Cloudflare, sends the selected values through the runtime's private management interface. Restore PostgreSQL together with the same installation key.

The runtime encrypts each version's secrets in its immutable connector snapshot using a separate `WIDEFLEET_CONNECTOR_KEY`. This key is independent of the runtime control token, so changing the control token does not invalidate connector secrets. Self-hosted installations create and retain one random key per fleet in fleet object storage; back up the full fleet storage and persistent runtime state together. Hosted deployments require `WIDEFLEET_CONNECTOR_KEY` as a runtime Worker secret through the deployment configuration. Generate 32 random bytes encoded as 64 lowercase hexadecimal characters, for example with `openssl rand -hex 32`, and preserve that key with the runtime storage backup. Replacing the encryption key requires keeping the old key or re-encrypting the snapshots; automatic key rotation is not implemented. These snapshots keep serving independent of management. The agent's activation journal contains version identities, not plaintext connector secrets. Historical encrypted snapshots remain after rotation or deletion. Administrators with the encryption keys and trusted connector code can read the values; protect those keys and the data plane accordingly.

Upgrade the control plane, CLI, agent and app runtime together before using Dynamic connectors.

## Connector logs

Owners and administrators can open **Connectors → expand a connector → View logs** to inspect runtime output, search messages and filter by severity, time and connector version. CLI users can read or follow the same records:

```sh
widefleet logs --connector erp --since 1h
widefleet logs --connector erp --level error --follow
widefleet logs --connector erp --version VERSION_ID --json
```

Connector logs use the existing runtime logging backend: Workers Logs on hosted Cloudflare and the [Collector/ClickHouse pipeline](/self-hosting/runtime-logs) on self-hosted installations. Enable that pipeline before querying self-hosted logs. If it is unavailable, the UI and API report the configuration problem; invocation results do not depend on successful log delivery.

Connector logs come from the same native `WorkerCode.tails` interface as app logs. Widefleet supplies trusted fleet, connector and version attribution and forwards the records to the configured backend. It does not replace console methods or wrap connector methods to capture additional events. Connector logs have separate ingestion credentials and administrator authorization; an app grant does not grant access to shared connector logs. Connector errors use the same source-map resolution as app errors. The UI, CLI and API show original source locations when the deployed package includes a matching map. Maps are selected from the logged connector version, including older deployments and secret-only updates; querying logs does not download code modules. Missing or invalid maps retain the generated stack so the original error remains visible.

Coverage depends on the runtime. celld 0.6.2 delivers tails for entrypoint `fetch()` calls, including their registered `waitUntil` work; it does not deliver tails for RPC or facet invocations. The local workerd tests verify native HTTP and RPC tails. In the celld 0.6.2 connector gateway test, a rejected `fetch()` call also produces no tail; do not rely on connector logs as a complete failure record. A missing native event is not reconstructed by Widefleet. See [runtime compatibility](/reference/runtime-compatibility) for the observed runtime differences.

Native capture limits and delivery behavior apply. Export is best-effort, without a durable Widefleet queue or retry, so outages and runtime termination can lose records. Keep credentials and unnecessary personal data out of console output. Confirm capture by invoking a connector HTTP endpoint, then refreshing **View logs** or running the CLI command above.

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

## Resources and activation

Connector configuration supports `vars`, D1, R2, KV and local Durable Object bindings. Resources belong to the connector, independently of similarly named app resources or another connector's resources. A connector does not inherit the loader's storage, administrative token or Worker Loader binding. Its normal outbound networking is independent of the user app's network allowlist; trusted connector code must enforce its own business restrictions.

An optional Wrangler `database_id` selects D1's logical identity, falling back to `database_name`. Widefleet scopes that identity to the connector and provisions the native resource. App binding-name conflicts are checked against active apps and queued/running app deployments.

Implement state in a `DurableObject` and declare its class in `durable_objects.bindings`. Widefleet hosts each object as a persistent facet behind a shared runtime Durable Object. Connector classes do not need native class migrations; the CLI removes Wrangler `migrations` from the published package, so a project can retain them for local native development.

Keep the fleet, connector, class name and object ID stable to preserve state across deployments. Different connectors can use the same class name without sharing data. Within one connector, bindings to the same class share its namespace. Address the same object deliberately, for example `env.STATE.getByName("erp-connection")`. Object IDs are opaque platform identifiers; use `idFromString()` to restore a saved ID. Renaming a connector or class creates a different namespace and does not migrate stored data.

Connector objects support SQLite and key-value storage, RPC and `fetch()`. Facet storage alarms are unavailable in celld 0.6.2 and the tested workerd runtime: native `setAlarm()` rejects the call. Widefleet does not redirect alarms to a different object or modify the storage API. Before replacing a loaded facet, it waits for active calls, response streams and registered `waitUntil` work. A response stream keeps its version until it completes, fails or is cancelled, including asynchronous cancellation cleanup. Calls within the same version can interleave, including nested calls while that version drains. WebSockets are outside the connector contract: celld 0.6.2 facets cannot hibernate WebSocket connections.

Connector code and secret updates prepare an immutable version, check readiness and switch the active version. They do not require a native Worker deployment or a celld reload. Adding or changing native resources can still update shared runtime configuration. New calls from every bound app resolve the active connector version; existing calls retain their selected code and secret snapshot. An object that has already advanced to a newer version rejects requests from an older version instead of downgrading its state handler.

Failed preparation leaves the serving version active, and activation retries are idempotent. Check `widefleet connector show NAME` to distinguish desired from confirmed serving state after a failed operation, then retry the deployment. Before removing installed entrypoints, both desired app grants and actual serving snapshots are checked: a failed revocation cannot authorize removing a still-used entrypoint.

Installed code, configuration, bindings and state remain in the data plane. Serving apps and ordinary runtime restarts work without the control plane or deployment agent. App deletion removes that app's references, not a shared connector or its data.

Use matching platform releases containing Dynamic connector support. Runtime versions remain immutable; published runtime releases must use a new version for changed bytes. The Dynamic connector publication contract replaces the earlier native connector format; it does not include a native connector migration path.

`vars` are ordinary package configuration; use the dedicated secret commands for credentials. Connector cron/queue configuration, cross-fleet bindings and connector removal commands are not implemented here. Runtime updates preserve installed connectors. Native RPC/DO/telemetry differences are described in the [celld compatibility notes](/reference/runtime-compatibility).

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
