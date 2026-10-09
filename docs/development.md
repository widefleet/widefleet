# Platform development

Set up the repository, run local checks and work on Widefleet itself. To build an app on an existing installation, follow [CLI installation](https://widefleet.com/docs/getting-started/installation). Run commands below from the repository root unless a step changes directories.

## Local demo

Start with the [README quickstart](../README.md#try-it-locally), including its prerequisites, test login and local certificate setup. Once the demo is running:

```sh
./dev cli apps         # Use the real Rust CLI as the local test administrator
./dev cli logs --level error --json
./dev cli history "$(./dev app-id)"
./dev deploy           # Rebuild and publish changes in starters/sveltekit
./dev logs
./dev down             # Stop the stack and app containers; keep data
./dev up               # Resume and redeploy the example; keep notes and photos
./dev reset --yes      # Permanently remove all local demo apps and data
```

This isolated demo uses synthetic identities and local-only credentials. Its CLI wrapper obtains a five-minute test-admin token from the local installation, so a desktop keyring is not needed for the walkthrough. Browser logins still use the real OIDC integrations. Native `widefleet login` remains available when testing the OS credential store. The emulator recreates its identities at startup; the demo reconciles its two fixture accounts while retaining application data.

Only loopback ports are published. Demo state lives in `.local/demo` and the `widefleet-local` Compose volumes. One checkout can own the demo at a time. The local fixture is separate from the deployment in `infra/compose.yaml`; use the [operations guide](https://widefleet.com/docs/self-hosting/installation) for a company installation.

## Repository layout

| Location                 | Purpose                                                               |
| ------------------------ | --------------------------------------------------------------------- |
| `apps/control-plane`     | Management UI, Better Auth, oRPC/OpenAPI, PostgreSQL and artifact API |
| `apps/docs`              | Public documentation website                                          |
| `packages/app-runtime`   | Versioned Worker loader and resource adapters                         |
| `packages/contracts`     | Validated public API schemas                                          |
| `crates/platform-cli`    | Creator CLI and device login                                          |
| `crates/platform-agent`  | Docker and celld deployment execution                                 |
| `crates/platform-core`   | Shared Rust HTTP, configuration and upload contract                   |
| `starters/sveltekit`     | SvelteKit app with D1 notes and R2 photos                             |
| `infra/compose.yaml`     | Single-host reference deployment                                      |
| `infra/test`             | Disposable PostgreSQL and RustFS fixtures                             |
| `patches`                | Versioned dependency fixes and docs consent integration               |
| `tools/oxlint/anti-slop` | Vendored lint rules and their original license                        |

The documentation website lives in `apps/docs`; see [documentation site development and hosting](documentation-site.md).

## Local verification

Use Node.js 26, pnpm 12.4.2 and Rust 1.99. Docker Engine 29.8.1 must be running. Runtime tests currently target Linux x86-64. The test configuration binds only to loopback and keeps all service data in temporary filesystems. Tests create separate databases and S3 buckets with synthetic identities; they do not need an Entra tenant.

```sh
pnpm install --frozen-lockfile
docker compose -f infra/test/compose.yaml up -d --wait
pnpm exec playwright install chromium
pnpm check
pnpm exec vitest run
pnpm build
pnpm --filter @platform/control-plane test:e2e
bash tools/cargo.sh fmt --all --check
bash tools/cargo.sh clippy --workspace --all-targets -- -D warnings
bash tools/cargo.sh test --workspace
```

Build the CLI with `bash tools/cargo.sh build -p platform-cli`, then run `RUN_CLI_TESTS=1 pnpm exec vitest run apps/control-plane/tests/cli.test.ts apps/control-plane/tests/network-cli.test.ts` to check deployment output against a local synthetic API. The suite covers activation, failure, queued output, explicit app IDs, server-provided ports and separation of build logs from JSON.

Vitest exercises PostgreSQL and S3 through real local services. Playwright starts the built Node server and verifies Microsoft login, device authorization and management forms. The browser suite sends the protocol header that a trusted TLS proxy supplies in deployment.

Enable the additional integration suites after building their local binaries and images:

```sh
bash tools/install-celld.sh
bash tools/cargo.sh build --workspace
docker build -f infra/runtime/Dockerfile -t app-platform-runtime:0.1.0 .
docker build -f infra/agent/Dockerfile -t app-platform-agent:0.1.0 .
docker build -f infra/control-plane/Dockerfile -t app-platform-control-plane:0.1.0 .
RUN_ENTRA_TESTS=1 RUN_IMAGE_TESTS=1 pnpm exec vitest run --no-file-parallelism
RUN_RUNTIME_TESTS=1 pnpm exec vitest run apps/control-plane/tests/runtime/deployment.test.ts
RUN_EDGE_TESTS=1 pnpm exec vitest run apps/control-plane/tests/edge/sso.test.ts
```

The native runtime command above assumes rootless Docker. With a rootful daemon, run that command with the same host UID as the packaged agent/runtime (root), as CI does:

```sh
sudo env "PATH=$PATH" \
  "DOCKER_HOST=$(docker context inspect --format '{{.Endpoints.docker.Host}}')" \
  "PLAYWRIGHT_BROWSERS_PATH=$HOME/.cache/ms-playwright" \
  RUN_RUNTIME_TESTS=1 pnpm exec vitest run apps/control-plane/tests/runtime/deployment.test.ts
```

Otherwise the runtime cannot write the test agent's bind-mounted state and reports `Permission denied` for `/state/node`. Keep the runtime's dropped capabilities and filesystem protections enabled.

The runtime suite extracts a CLI release outside the workspace, initializes and checks an independent app, then uses the actual CLI and agent to deploy it. It saves a note and photo, exercises Node ESM imports and CommonJS builtins with `nodejs_compat`, checks preview isolation and code rollback, restarts an app with management stopped, and deletes its resources. The image suite initializes an empty database and buckets twice, renders proxy configuration using the packaged setup tool, then publishes a Worker through the packaged server and actual agent/runtime containers. Edge tests run the pinned Traefik and OAuth2 Proxy images and verify identity-header spoofing, credential removal, cookie boundaries and paginated Entra group overage, including fresh logins after restarting the proxies without a control plane or database. Finish image builds before running browser tests, and run browser, runtime and edge suites sequentially. Some share ports; creating or removing Docker networks can also interrupt Chromium requests with `ERR_NETWORK_CHANGED`. With `./dev up` running, `RUN_LOCAL_TESTS=1 pnpm exec vitest run apps/control-plane/tests/local/quickstart.test.ts` checks the complete demo through both browser logins and leaves a synthetic note and photo in the example app.

Remove the disposable test services when finished:

```sh
docker compose -f infra/test/compose.yaml down
```

These containers have no durable volumes. Stopping them discards their databases and object storage.

### App access

Local tests use synthetic identities with the pinned Traefik and OAuth2 Proxy
images. They cover per-host allow/deny behavior, spoofed headers and query
parameters, empty lists, existing sessions, group overage, proxy restart,
inheritance, activation failures, stale edits, legacy agents and code rollback.

### Workflows

Use synthetic data and the pinned local runtime:

```sh
pnpm --filter @platform/app-runtime build
RUN_DYNAMIC_TESTS=1 pnpm exec vitest run \
  apps/control-plane/tests/runtime/workflows.test.ts \
  apps/control-plane/tests/runtime/workflow-adapter.test.ts
```

The production adapter suite covers abrupt restarts, retries, timeouts, events, parallel replay, structured-clone results, scoped storage, version pinning, connector revocation and management receipts. The deployment suite also exercises the packaged CLI, agent, retained resources and app removal against a disposable local fleet.

### Installation reporting

Integration tests use isolated local PostgreSQL databases and a synthetic PostHog transport. They exercise payload filtering, independent opt-outs, configuration overrides, queued-batch revocation, authorization and failed delivery without sending events to the real project.

### Runtime logs

```sh
docker compose -f infra/test/compose.yaml up -d --wait
docker compose -f infra/test/telemetry.yaml up -d --wait
bash tools/install-celld.sh
RUN_TELEMETRY_TESTS=1 pnpm exec vitest run apps/control-plane/tests/telemetry.integration.test.ts
RUN_CAPTURE_TESTS=1 pnpm exec vitest run apps/control-plane/tests/runtime/error-capture.test.ts
```

The telemetry suite uses synthetic identities and OTLP payloads, the actual Collector/ClickHouse, real celld and the CLI. It checks app isolation, permissions, source maps from old browser builds, filtering, pagination, delayed exports, read-only name resolution and follow. The capture suite uses a built starter and Chromium to exercise browser and server capture. The deployment suite additionally checks shared runtime activation and restart with existing D1/R2 data.

## Run management from source

The configuration template is `apps/control-plane/.env.example`. Supply PostgreSQL, a private artifact bucket and writable local state. Startup creates the database schema and CLI client; open the browser to create the first administrator and configure company SSO. An optional bootstrap file supports automated first setup. See [configuration, secret storage and recovery](https://widefleet.com/docs/self-hosting/installation).

Better Auth's Organization plugin stores Owner, Admin and Member roles. Every Member can create apps. The setup administrator explicitly links and tests a company account before closing password authentication. Subsequent verified management sign-ins create Members; app-only SSO does not enroll management members. Agent credentials remain separate and are stored as hashes.

```sh
cd apps/control-plane
cp .env.example .env
# Fill in infrastructure settings before continuing.
node --env-file=.env --run dev
```

To run the built management application, build from the repository root, then use `node --env-file=.env --run start` in `apps/control-plane`. This does not start an agent, app runtime or SSO proxy.

The production server requires `BODY_SIZE_LIMIT=32M` for the supported Worker upload limit. Keep the Node listener private to the trusted proxy. Set `PROTOCOL_HEADER=x-forwarded-proto` only when that proxy overwrites the header. The externally visible origin must match `PLATFORM_URL`. HTTPS is required except for loopback development.

SvelteKit's CSRF protection and Better Auth's protections remain enabled. `/api/auth/*` uses Better Auth's normal SvelteKit integration; there is no custom Node authentication bypass. See the [API contract](https://widefleet.com/docs/reference/api) for client request requirements.

## Dependency constraints

TypeScript extends `@tsconfig/strictest`. Type-aware Oxlint, the generic anti-slop rules and Oxfmt remain enabled. Expected operational errors use `better-result`.

Better Auth 1.7.7 declares a SvelteKit 2 peer range. `pnpm-workspace.yaml` allows only the selected Better Auth 1.7.7 / SvelteKit 3.0.0 pair. Its integration is covered by tests against the built server. The OAuth provider patch removes incompatible optional `undefined` declarations from generated OpenAPI types; runtime JavaScript is unchanged. Review both exceptions when upgrading.

The TypeScript version remains 6.0.3 for the selected Svelte compiler integration. Oxlint and `@oxlint/plugins` must stay on the same version. Wrangler's asset hash implementation uses `blake3-wasm` 2.1.5.

The starter checks authored TypeScript and Svelte sources. JavaScript checking is disabled there because Wrangler's generated `GlobalProps` imports the adapter's generated Worker bundle; checking that JavaScript would re-check bundled dependencies as application source. All `strictest` TypeScript options remain enabled.

## GitHub Actions

The repository has seven workflows:

| Workflow                    | Trigger and purpose                                                                                         |
| --------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `check.yaml`                | Pull requests and pushes to `main`; requires all source and integration suites to pass.                     |
| `check-suites.yaml`         | Reusable source, integration/browser, packaged SSO, and Rust/runtime test suites.                           |
| `check-release-images.yaml` | Relevant pull requests and pushes to `main`; builds and tests the packaged images without publishing.       |
| `build-release-images.yaml` | Reusable parallel image builds, Cargo and image caching, artifact transport, and packaged deployment tests. |
| `publish-cli.yaml`          | Published stable `vVERSION` GitHub Releases; publishes the tested CLI to npm.                               |
| `publish-images.yaml`       | Published stable `vVERSION` GitHub Releases; publishes the tested images to Docker Hub.                     |
| `publish-app-runtime.yaml`  | `runtime-vVERSION` tag pushes; tests and creates the independent app-runtime GitHub Release.                |

The npm and Docker workflows require a published stable GitHub Release. Failed runs use GitHub Actions' built-in rerun controls. See [CLI releases](cli-releases.md), [container releases](container-releases.md) and [runtime releases](runtime-releases.md) for authentication and release instructions.

PR jobs receive read-only cache access; only checks triggered by pushes to `main` can save caches. Test jobs use disposable services and synthetic fixtures.
