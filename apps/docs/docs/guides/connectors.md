---
title: IT connectors
description: Deploy integrations, manage secrets and grant apps native RPC bindings.
---

IT can deploy a Worker from its own repository with `widefleet connector deploy`. Apps receive a native service binding and call its methods directly, for example `env.ERP.listCustomers()`. Connector code runs as a regular Worker in the shared fleet, with its own declared resources. It is independent of the Widefleet runtime and Rust agent releases.

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

The CLI bundles TypeScript/JavaScript and installed dependencies, discovers exported entrypoints, uploads the artifact and waits for activation. There is no required package version bump or release-file handling. `--config PATH` selects another Wrangler file; `--no-wait` returns after queuing. Build progress uses stderr; `--json` or redirected stdout returns structured results. Run any project-specific code generation before deployment.

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

The control plane encrypts values using the installation encryption key and stores the ciphertexts directly in the connector activation snapshots in PostgreSQL. Desired, applied and queued job snapshots own their secret values independently of login settings and credential cleanup. Source artifacts contain no managed secret values. Only the agent holding the active job lease receives decrypted values. Restore PostgreSQL together with the same installation key. Historical snapshots retain ciphertext copies for recovery; this trades additional database storage for self-contained deployment state and avoids a database lookup per secret.

The initial backend injects plaintext variables into each secret Worker's private fleet configuration. Values can therefore exist in agent staging files, activation journals, fleet object storage manifests and backups. Fleet/storage administrators and trusted connector code can read them. Deleting or rotating a secret changes the serving configuration; it does not erase historical copies. Protect and back up the data plane accordingly. This backend keeps serving during control-plane outages.

Upgrade the control plane, CLI and agent together before using this feature. No database migration or new app-runtime release is required. A future optional Azure Key Vault backend with Managed Identity can keep the same asynchronous getter; it is not implemented here. Such a migration must account for historical plaintext copies and credential rotation, and must not silently fall back to this backend.

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

There is no `connect()`, generic `invoke()` or translation into HTTP. The binding grants the selected entrypoint's native RPC surface. To expose a narrower API, the connector author exports a separate `WorkerEntrypoint` class and IT selects it with `--entrypoint CustomerReader`. Widefleet does not maintain lists of business methods. The IT project supplies the corresponding TypeScript interface or type package to app projects; automatic type distribution is not provided.

Bindings default to the connector's `default` export. celld 0.6.1 requires a default Worker export even when callers select a named entrypoint. Export a `WorkerEntrypoint` class as default, or supply a default fetch handler alongside named entrypoints. Exported Durable Object classes are excluded from the CLI's entrypoint list.

A binding can be saved before the app's first deployment. Otherwise changes wait for activation, unless `--no-wait` is used. Status distinguishes saved, pending, active and failed; repeating a failed change retries it. A failed code deployment does not mark already active grants as failed. Previews start without connector grants, and app code rollback keeps current bindings. Resource-name collisions and reserved `WIDEFLEET_` names are rejected.

## Resources and activation

Connector configuration supports `vars`, D1, R2, KV and local Durable Object bindings with `new_sqlite_classes` migrations. Resources belong to the connector, independently of similarly named app resources. A connector does not inherit the loader's storage, administrative token or Worker Loader binding. Its normal outbound networking is independent of the user app's network allowlist; trusted connector code must enforce its own business restrictions.

An optional Wrangler `database_id` is accepted for D1; Widefleet assigns its fleet-local storage identity from the connector and database names. Binding-name conflicts are checked against active apps and queued/running app deployments. DO class names remain reserved while either the desired or applied connector package declares them, including after a failed update.

The IT project can implement state in a normal `DurableObject`, declare it in `durable_objects.bindings`, and register its class in `migrations`. Keeping the connector and class names stable preserves that namespace across deployments. Shared state requires deliberately addressing the same object, such as `env.STATE.getByName("erp-connection")`. celld currently requires DO class names to be unique across the fleet; namespace/class renames are not a supported data migration. Automatic facets are not introduced.

Connector updates use a celld reload and affect every app bound to that connector. The existing activation journal and recovery path preserve the previous serving generation on failure. Before changing installed entrypoints, both desired app grants and actual serving snapshots are checked: a failed revocation cannot authorize removing a still-used entrypoint. Already-running requests can finish under their previous bindings.

Installed code, configuration, bindings and state remain in the data plane. Serving apps and ordinary runtime restarts work without the control plane or deployment agent. App deletion removes that app's references, not a shared connector or its data.

Use matching CLI, control-plane and agent releases. Connector support is included in `0.3.0`. Upgrades from pre-connector development snapshots require a fresh fleet: migration `0009` rejects existing apps, selected runtimes or running jobs before adding the connector schema. It does not migrate those earlier loaders or snapshots. Runtime versions remain immutable; published runtime releases must use a new version for changed bytes.

`vars` are ordinary package configuration; use the dedicated secret commands for credentials. Connector cron/queue configuration, cross-fleet bindings and connector removal commands are not implemented here. Runtime updates preserve installed connectors. Native RPC/DO/telemetry differences are described in the [celld compatibility notes](/reference/runtime-compatibility).

## API

The OpenAPI document includes connector artifact schemas and normal OAuth authentication:

| Operation                               | Endpoint                                                                                              |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| List / inspect connector deployments    | `GET /api/v1/connectors`, `GET /api/v1/connectors/{name}`                                             |
| List secret names and activation status | `GET /api/v1/connectors/{name}/secrets`                                                               |
| Set / delete a connector secret         | `PUT /api/v1/connectors/{name}/secrets/{secret}` with `{ "value": "..." }`, `DELETE` at the same path |
| Upload and deploy the bundled project   | `PUT /api/v1/connectors/{name}`                                                                       |
| Read app bindings and activation state  | `GET /api/v1/apps/{appId}/bindings`                                                                   |
| Set one binding                         | `PUT /api/v1/apps/{appId}/bindings/{binding}` with `{ "connector": "erp", "entrypoint": "default" }`  |
| Remove one binding                      | `DELETE /api/v1/apps/{appId}/bindings/{binding}`                                                      |

Binding updates are atomic and do not require a caller-supplied revision. Connector deployment, listing and grant changes require administrator access. App Developers, App admins and Owners can read their app's bindings. CLI users select names and project context; IDs remain API identifiers.
