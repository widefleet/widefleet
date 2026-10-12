---
title: IT connectors
description: Find integrations, inspect app connections and manage native RPC bindings.
lastModified: 2026-10-12
---

IT can deploy a Worker from its own repository with `widefleet connector deploy`. Apps receive a native service binding and call its methods directly, for example `env.ERP.listCustomers()`. Connector code runs as a regular Worker in the shared fleet, with its own declared resources. It is independent of the Widefleet runtime and Rust agent releases.

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

The CLI bundles TypeScript/JavaScript and installed dependencies, discovers exported entrypoints, uploads the artifact and waits for activation. `--config PATH` selects another Wrangler file; `--no-wait` returns after queuing. Build progress uses stderr; `--json` or redirected stdout returns structured results. Run any project-specific code generation before deployment.

Each artifact is immutable and identified by its content checksum. PostgreSQL stores references and deployment status; Object Storage stores code and configuration. Repeating an unchanged successful or pending deployment reuses it; repeating a failed deployment retries. To restore previous code, deploy the previous source checkout. This does not reverse data changes. A newer concurrent deployment is reported explicitly if it supersedes a waiting command.

## Connector secrets

After deploying the connector, an owner/admin can set its secrets without uploading code again:

```sh
widefleet connector secret put erp ERP_API_KEY --file /private/erp-api-key
widefleet connector secret put erp ERP_API_KEY < /private/erp-api-key
widefleet connector secret list erp
widefleet connector secret delete erp ERP_API_KEY
```

Values are accepted only through a file or redirected stdin, never a command-line argument. Input is preserved exactly, including trailing newlines; use a file without a final newline when the credential requires it. The CLI accepts 1–65536 UTF-8 bytes. `put` and `delete` wait for activation; `--no-wait` returns after queuing. Listing returns names and activation status, never values. These operations use the same administrator permissions and ordinary login as connector deployment.

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

Missing secrets reject the promise. Secret names are case-sensitive and follow binding-name syntax. The prefix `WIDEFLEET_` and the name `__proto__` are reserved. Ordinary `vars` remain separate; a same-named variable does not satisfy a secret lookup. The getter runs in a separate platform-owned Worker for each connector, reached through a native service binding in the same celld process. Connector code is deployed unchanged. Apps cannot bind to the secret Worker. Trusted connector authors must keep secret values out of business responses and logs. For local Wrangler tests, supply a test implementation of the binding; Widefleet provides it during fleet activation.

Changes activate the connector's currently desired code and a fixed snapshot of its secrets. `secretRevision` and `appliedSecretRevision` distinguish the saved and serving configurations independently of the code checksum. A failed activation retains the previous serving generation. Retry by setting the secret again or redeploying the desired source; code rollback preserves the latest desired secrets. Requests already in flight may finish with the previous generation. Secrets belong to the connector, not to a particular app or user.

### Storage and recovery

The control plane encrypts values using the installation encryption key and stores the ciphertexts directly in the connector activation snapshots in PostgreSQL. Desired, applied and queued job snapshots own their secret values independently of login settings and credential cleanup. Source artifacts contain no managed secret values. Only the agent holding the active job lease receives decrypted values. Restore PostgreSQL together with the same installation key. Historical snapshots retain ciphertext copies for recovery.

The backend keeps secrets available during control-plane outages by storing plaintext variables in each secret Worker's private fleet configuration. Values can also exist in agent staging files, activation journals, fleet object storage manifests and backups. Fleet/storage administrators and trusted connector code can read them. Deleting or rotating a secret updates the serving configuration; historical copies remain. Protect and back up the data plane accordingly.

Upgrade the control plane, CLI and agent together before using connector secrets.

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

The binding grants the selected entrypoint's native RPC surface. To expose a narrower API, the connector author exports a separate `WorkerEntrypoint` class and IT selects it with `--entrypoint CustomerReader`. The IT project supplies the corresponding TypeScript interface or type package to app projects.

Bindings default to the connector's `default` export. celld 0.6.1 requires a default Worker export even when callers select a named entrypoint. Export a `WorkerEntrypoint` class as default, or supply a default fetch handler alongside named entrypoints. Exported Durable Object classes are excluded from the CLI's entrypoint list.

A binding can be saved before the app's first deployment. Otherwise changes wait for activation, unless `--no-wait` is used. Status distinguishes saved, pending, active and failed; repeating a failed change retries it. A failed code deployment does not mark already active grants as failed. Previews start without connector grants, and app code rollback keeps current bindings. Resource-name collisions and reserved `WIDEFLEET_` names are rejected.

## Resources and activation

Connector configuration supports `vars`, D1, R2, KV and local Durable Object bindings with `new_sqlite_classes` migrations. Resources belong to the connector, independently of similarly named app resources. A connector does not inherit the loader's storage, administrative token or Worker Loader binding. Its normal outbound networking is independent of the user app's network allowlist; trusted connector code must enforce its own business restrictions.

An optional Wrangler `database_id` is accepted for D1; Widefleet assigns its fleet-local storage identity from the connector and database names. Binding-name conflicts are checked against active apps and queued/running app deployments. DO class names remain reserved while either the desired or applied connector package declares them, including after a failed update.

The IT project can implement state in a normal `DurableObject`, declare it in `durable_objects.bindings`, and register its class in `migrations`. Keeping the connector and class names stable preserves that namespace across deployments. Shared state requires deliberately addressing the same object, such as `env.STATE.getByName("erp-connection")`. celld requires DO class names to be unique across the fleet; namespace/class renames are not a supported data migration.

Connector updates use a celld reload and affect every app bound to that connector. The existing activation journal and recovery path preserve the previous serving generation on failure. Before changing installed entrypoints, both desired app grants and actual serving snapshots are checked: a failed revocation cannot authorize removing a still-used entrypoint. Already-running requests can finish under their previous bindings.

Installed code, configuration, bindings and state remain in the data plane. Serving apps and ordinary runtime restarts work without the control plane or deployment agent. App deletion removes that app's references, not a shared connector or its data.

Use matching CLI, control-plane and agent releases. Connector support is included in `0.3.0`. Upgrades from pre-connector development snapshots require a fresh fleet: migration `0009` rejects existing apps, selected runtimes or running jobs before adding the connector schema. Runtime versions remain immutable; published runtime releases must use a new version for changed bytes.

`vars` are ordinary package configuration; use the dedicated secret commands for credentials. Connector cron/queue configuration, cross-fleet bindings and connector removal commands are not implemented here. Runtime updates preserve installed connectors. Native RPC/DO/telemetry differences are described in the [celld compatibility notes](/reference/runtime-compatibility).

## API

The OpenAPI document includes connector artifact schemas and normal OAuth authentication:

| Operation                                                     | Endpoint                                                                                              |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Browse connector names and grantable entrypoints              | `GET /api/v1/connector-catalog`                                                                       |
| Inspect app resources and desired / active connector bindings | `GET /api/v1/apps/{appId}/connections`                                                                |
| List / inspect connector deployments                          | `GET /api/v1/connectors`, `GET /api/v1/connectors/{name}`                                             |
| List secret names and activation status                       | `GET /api/v1/connectors/{name}/secrets`                                                               |
| Set / delete a connector secret                               | `PUT /api/v1/connectors/{name}/secrets/{secret}` with `{ "value": "..." }`, `DELETE` at the same path |
| Upload and deploy the bundled project                         | `PUT /api/v1/connectors/{name}`                                                                       |
| Read app bindings and activation state                        | `GET /api/v1/apps/{appId}/bindings`                                                                   |
| Set one binding                                               | `PUT /api/v1/apps/{appId}/bindings/{binding}` with `{ "connector": "erp", "entrypoint": "default" }`  |
| Remove one binding                                            | `DELETE /api/v1/apps/{appId}/bindings/{binding}`                                                      |

Binding updates are atomic and do not require a caller-supplied revision. Connector deployment, administrative status listing and grant changes require administrator access. Members can browse the connector catalog; app collaborators can read their app's connections and bindings. CLI users select names and project context; IDs remain API identifiers.
