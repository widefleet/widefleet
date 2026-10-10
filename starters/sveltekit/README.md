# SvelteKit app on Widefleet

This is an independent app project. It needs Node.js 26, pnpm 12.4.2 and an installed Widefleet CLI release. Docker and the Widefleet source repository are not required on the developer machine.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm dev
```

Local development uses a synthetic identity. Deployed apps receive the verified company identity as `locals.user`; the platform enforces SSO before forwarding requests. The starter includes D1 notes and private R2 photos.

## Deploy

Connect to your company, then authenticate. The CLI uses company-provided or saved configuration. Otherwise, it asks for your work email or company domain. Approve the device code in your browser; subsequent commands use the saved URL and session.

```sh
widefleet login
widefleet deploy
```

For an agent or noninteractive terminal, use `widefleet login --email employee@example.com` or `widefleet login --domain example.com`. IT must publish the company's TXT record or HTTPS discovery file, or preconfigure the agent's environment. Run `widefleet config show` to inspect the selected URL. An explicit URL supplied by IT remains supported through `widefleet login --url https://platform.example.com`.

The deployment target is the combination of the selected platform and `name` in `wrangler.jsonc`, following Wrangler's account-and-Worker-name model. `widefleet init` derives this name from the project directory. Review it before the first deployment. The first deploy creates the app; later deploys with the same name update it if you have permission. A fresh checkout works with the same configuration and login, without a local app-ID file or linking command. Changing `name` selects another app, and a deleted app is created again if deployed under that name.

The platform assigns the shared fleet. Each app keeps its own identity and resources independently of the deployment executor. Run deployment from this directory, or pass `--config /path/to/wrangler.jsonc`. The CLI runs `pnpm run build`, bundles the Worker using its own esbuild executable, uploads it and waits for activation. Failures return a nonzero exit status. `--skip-build` skips the app build, and `--no-wait` returns after queueing the deployment.

This flow requires CLI and management server 0.1.5 or newer. Explicit `widefleet deploy APP_UUID` remains available for existing scripts and overrides the configured name for that invocation. Use `widefleet apps` to inspect app IDs for history, rollback and administration.

Login uses an unlocked OS credential store by default. In a headless Unix shell, a CLI build with `--session-file` support can instead store the session in an explicitly selected, unencrypted file:

```sh
export PLATFORM_SESSION_FILE="$HOME/.local/state/widefleet/session.json"
widefleet login
```

Keep this variable set for subsequent commands, including `widefleet logout`. The CLI creates a private directory (`0700`) and file (`0600`), renews tokens automatically and binds the file to the selected platform. File permissions do not prevent other processes running as your user from reading the tokens. Keep the file outside this project and shared artifacts. For externally managed credentials, an operator may supply a short-lived API access token as `PLATFORM_ACCESS_TOKEN`; it takes precedence over the saved session and is not renewed automatically. Never commit credentials.

## App contract

- Edit `src/routes` to build your app. Read `locals.user` in server handlers; the server hook validates the platform identity headers.
- Declare D1, R2, KV, queue producers/consumers, cron schedules, static assets and plain text variables in `wrangler.jsonc`. Resource names remain stable across deployments. The initial names are isolated per app.
- The MVP supports a single bundled Worker module. The starter enables `nodejs_compat`; existing `nodejs_als` projects remain supported. Unsupported configuration is rejected.
- App cookies are unavailable: the platform removes request cookies and response `Set-Cookie`. Do not implement a separate cookie login.
- Database and file contents survive code deployments and rollback. Apply schema migrations explicitly with `widefleet migrations`; deployments do not run them.
- TypeScript uses strictest; `pnpm check` runs type checking, Oxfmt and type-aware Oxlint with anti-slop. Generated Worker JavaScript is excluded from TypeScript checking.

After the parent app exists, run `widefleet preview --name review` to build and deploy an isolated preview. It inherits app access groups, but has separate data, network permissions and connector grants. Use `widefleet events APP_UUID DEPLOYMENT_UUID` for deployment diagnostics and `widefleet rollback APP_UUID ARTIFACT_UUID` for a retained code version.

## Database migrations

Migration commands require CLI and platform 0.3.0 or newer. Use matching CLI, management and agent versions and an already deployed D1 binding. Add reviewed SQL files such as `migrations/0001_add_tasks.sql`, then run:

```sh
widefleet migrations list DB
widefleet migrations apply DB
```

`DB` is the binding in `wrangler.jsonc`. Applied files are tracked by name; add new files rather than editing applied ones. Each file is transactional; earlier successful files remain applied if a later file fails. Fix the pending file and retry. For a new database, first deploy code that declares the binding and can start without the new schema. Then migrate and deploy code that uses it. Keep changes compatible with the currently serving app; code rollback does not undo schema changes.

## Storage and background handlers

Resources are created only when declared in `wrangler.jsonc`. Equal resource names in different apps/previews stay isolated. `d1_databases`, `r2_buckets`, `kv_namespaces`, `queues.producers`, `queues.consumers` and `triggers.crons` use Wrangler-style configuration. Keep identifiers stable to keep using the same data. Removing a binding does not migrate or erase its native data.

Use the normal D1, R2, KV and Queue producer APIs from `env`. The dynamic runtime's adapters preserve D1 prepared statements/batches/sessions, R2 metadata/ranges/multipart operations, and KV text/JSON/bytes/metadata/listing. celld 0.6.1 does not implement `D1.dump()`, and customer-provided R2 encryption keys are unsupported. KV streams use native service-binding HTTP transport; celld still buffers values internally.

A custom Worker entry module may export `scheduled(controller, env, ctx)` and `queue(batch, env, ctx)` alongside `fetch`. The platform forwards `waitUntil`, `noRetry`, message acknowledgments and retry decisions. The SvelteKit HTTP adapter does not create these handlers automatically; an entry wrapper must export them explicitly.

App Workflows require CLI and platform 0.3.0 or newer, a matching deployment agent and app runtime 0.2.0 or newer advertising Workflow support. Declare `workflows` entries with `binding`, `name` and `class_name`, and export the corresponding `WorkflowEntrypoint` classes from the main module alongside the generated HTTP handler. Use `widefleet workflows --help` for management commands. User-defined Durable Object namespaces remain outside the dynamic app contract.

Apps run as Dynamic Workers on the shared fleet. Code rollback retains current data. Runtime updates are managed separately by the operator. External network access requires an explicit platform grant; the backend and browser have separate lists.

## Network access

After the app exists, an owner or administrator can grant exact HTTPS origins through the normal login and CLI:

```sh
widefleet login --scope platform:read platform:write network:manage
widefleet network
widefleet network allow https://api.example.com
widefleet network allow https://assets.example.com --browser
widefleet network deny https://api.example.com
```

Commands use this project's configured name; `--app NAME` selects another existing app. No UUID, policy file or manual revision is needed. Changes wait for activation unless `--no-wait` is supplied. Backend and browser lists start empty. Same-origin browser requests and resource bindings remain usable. Policy state is managed by the platform; do not add network settings to Wrangler configuration. Code rollback does not revert grants, and previews have their own permissions.

A browser grant allows connections and resource loading, including scripts/styles, from that origin. CSP allows same-origin/inline scripts and styles; frames, objects and Web Workers are blocked. App headers cannot remove the policy. CSP does not prevent every browser action or external navigation; open tabs need a reload to receive changes. Backend redirects are checked at every hop. Body-preserving redirects can replay fully sent uploads up to 1 MiB; original uploads are streamed without that limit.

## Node.js compatibility

With `"compatibility_flags": ["nodejs_compat"]`, Widefleet leaves Node builtins such as `node:buffer`, `node:crypto` and bare imports such as `path` for celld to resolve. npm dependencies are bundled locally, Worker package export conditions are enabled, and bundled CommonJS dependencies can require runtime builtins. Existing apps can opt in by changing this flag and redeploying with CLI 0.1.3 or newer against an updated management server.

Support is limited to [celld 0.6.1's Node APIs](https://github.com/denoland/celld/blob/v0.6.1/docs/cloudflare-compat.md#nodejs-compatibility). Some APIs are partial or throw when called: for example, crypto ciphers and child processes are unavailable, and `fs` is restricted to celld's virtual filesystem. Successful bundling does not establish that every API used by a dependency works. This is not a full Node.js server runtime or complete Cloudflare compatibility.

celld already exposes its implemented Node APIs and does not use `nodejs_compat` as a runtime switch. In Widefleet the explicit flag selects the matching bundler behavior; the compatibility date alone does not enable it. The agent continues to deploy prebundled code without running a build or package scripts.

The platform validates app snapshots before activation. Rejected updates retain the serving version; interrupted installations are recovered by the executor before subsequent work.

## Runtime diagnostics

The starter reports unexpected SvelteKit server errors and browser JavaScript errors automatically. Browser reporting includes client navigation errors, global errors and unhandled promise rejections. Reports go to the authenticated `/_widefleet/errors` endpoint and enter celld through structured `console.error` output. Expected HTTP errors below 500 do not produce error reports. Server requests include their HTTP status, so a plain 5xx response is also visible even without a thrown exception.

When catching a technical failure intentionally, report it before returning a fallback:

```ts
// In a server handler, pass the SvelteKit request event.
import { captureError } from "../lib/server/capture-error.ts";
captureError(cause, event);
```

```ts
// In browser code, use the browser helper instead.
import { captureError } from "../lib/capture-error.ts";
captureError(cause);
```

Adjust relative import paths to your file. Keep the existing authentication hook when extending `hooks.server.ts`. The browser helper deduplicates repeated errors and limits reporting; it does not retry failed delivery. Reporting is best-effort. It omits cookies, headers, request bodies and URL query strings, but exception messages can still contain application data. Avoid putting credentials or sensitive inputs in exception messages.

The build generates source maps for both environments. The CLI uploads `.map` files as private deployment artifacts and excludes them from the public asset manifest. The server map follows esbuild's combined output back through SvelteKit's build maps. Each upload records the SvelteKit build version, which browser reports keep even when an old tab outlives a deployment. Source maps require updated CLI, management server and agent components together; existing builds must enable `build.sourcemap` in Vite to recover original application sources.

Existing apps can adopt the integration by copying `src/hooks.client.ts`, the error helpers in `src/lib`, and the corresponding additions to `hooks.server.ts`, `app.d.ts` and `vite.config.ts`. Merge those hooks with app-specific behavior and deploy a new build.

With the installation's ClickHouse telemetry enabled, query runtime errors directly:

```sh
widefleet logs --level error --since 1h --json
widefleet logs --source browser --json
widefleet logs --deployment DEPLOYMENT_UUID --json
widefleet logs --request-id REQUEST_ID --json
widefleet logs --trace-id TRACE_ID --json
widefleet logs --follow --json
```

The command resolves `name` in `wrangler.jsonc` using read-only access. An explicit app name or UUID overrides that name. The default is the latest 100 records received within the last hour; `--limit` accepts 1–500 and `--since` accepts `30m`, `1h`, `7d` or an ISO timestamp. `--until` bounds historical queries. `--level` is a minimum severity, `--query` searches the original message body, and `--json` emits one object per line with stack frames, build/deployment IDs and request/trace IDs when available. Redirected stdout also defaults to JSON lines. Original source-map columns are one-based.

`--follow` polls for newly ingested records, including delayed exports, and uses an overlap to avoid losing concurrent writes. Output follows arrival order; timestamps can therefore go backwards. It can backfill additional records from the overlap after the initial history. Stop with Ctrl-C. The browser sender and runtime exporter are bounded and best-effort; successful application requests do not depend on telemetry delivery. A telemetry outage is reported by the CLI rather than shown as an empty result.

App telemetry currently covers HTTP console records and exceptions. RPC, Cron and Queue logs and native distributed traces are not available through this channel. Tail delivery has no persistent retry queue.

## IT connector bindings

After IT grants a connector, call its native RPC methods directly, for example `env.ERP.listCustomers()`. IT supplies the connector's TypeScript interface. Use the normal CLI login and `widefleet connector bind erp --as ERP` from this app project (administrator permission required); `widefleet connector bindings` shows the current mapping and activation state. An explicit `--app NAME` selects another app. There is no `connect()` or generic `invoke()` step. Previews start without these grants; code rollback retains the current grants. Connector code and its optional Durable Objects are deployed separately with `widefleet connector deploy`.
