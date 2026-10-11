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

Build the CLI with `bash tools/cargo.sh build -p platform-cli`, then run `RUN_CLI_TESTS=1 pnpm exec vitest run apps/control-plane/tests/cli.test.ts apps/control-plane/tests/network-cli.test.ts` to check it against a local synthetic API.

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
sudo env -u SUDO_USER "PATH=$PATH" \
  "DOCKER_HOST=$(docker context inspect --format '{{.Endpoints.docker.Host}}')" \
  "PLAYWRIGHT_BROWSERS_PATH=$HOME/.cache/ms-playwright" \
  RUN_RUNTIME_TESTS=1 pnpm exec vitest run apps/control-plane/tests/runtime/deployment.test.ts
```

Otherwise the runtime cannot write the test agent's bind-mounted state and reports `Permission denied` for `/state/node`. Keep the runtime's dropped capabilities and filesystem protections enabled.

Finish image builds before browser tests, and run browser, runtime and edge suites sequentially. Some share ports; creating or removing Docker networks can also interrupt Chromium requests with `ERR_NETWORK_CHANGED`. The [CI suite configuration](../.github/workflows/check-suites.yaml) is the maintained source for test selection and setup.

With `./dev up` running, `RUN_LOCAL_TESTS=1 pnpm exec vitest run apps/control-plane/tests/local/quickstart.test.ts` checks the demo through both browser logins and leaves a synthetic note and photo in the example app.

### Workflows

After the integration setup above has installed celld, run the Workflow adapter checks with synthetic data:

```sh
pnpm --filter @platform/app-runtime build
RUN_DYNAMIC_TESTS=1 pnpm exec vitest run \
  apps/control-plane/tests/runtime/workflows.test.ts \
  apps/control-plane/tests/runtime/workflow-adapter.test.ts
```

### Runtime logs

```sh
docker compose -f infra/test/compose.yaml up -d --wait
docker compose -f infra/test/telemetry.yaml up -d --wait
bash tools/install-celld.sh
RUN_TELEMETRY_TESTS=1 pnpm exec vitest run apps/control-plane/tests/telemetry.integration.test.ts
RUN_CAPTURE_TESTS=1 pnpm exec vitest run apps/control-plane/tests/runtime/error-capture.test.ts
```

The telemetry fixtures use a local Collector and ClickHouse. The browser capture suite builds a starter app and uses Chromium. Installation-reporting tests use a synthetic PostHog transport; they do not send events to the real project.

Remove disposable test services when finished:

```sh
docker compose -f infra/test/telemetry.yaml down
docker compose -f infra/test/compose.yaml down
```

These containers have no durable volumes. Stopping them discards their databases and object storage.

## Run management from source

Use [`apps/control-plane/.env.example`](../apps/control-plane/.env.example) with local PostgreSQL, a private test artifact bucket and writable local state. Open the browser after startup to create the first administrator. Identity setup, configuration and recovery are documented in the [self-hosting guide](https://widefleet.com/docs/self-hosting/installation).

```sh
cd apps/control-plane
cp .env.example .env
# Fill in infrastructure settings before continuing.
node --env-file=.env --run dev
```

To run the built management application, build from the repository root, then use `node --env-file=.env --run start` in `apps/control-plane`. This does not start an agent, app runtime or SSO proxy.

When testing the built server, use `BODY_SIZE_LIMIT=32M` for supported Worker uploads and match the externally visible origin to `PLATFORM_URL`. For a trusted TLS proxy, set `PROTOCOL_HEADER=x-forwarded-proto` only if the proxy overwrites it and the Node listener stays private. HTTPS is required except for loopback development. Keep SvelteKit and Better Auth's request protections enabled; see the [API contract](https://widefleet.com/docs/reference/api) for client requirements.

## Dependency constraints

Better Auth 1.7.7 declares a SvelteKit 2 peer range. The [workspace constraints](../pnpm-workspace.yaml) allow only the selected Better Auth 1.7.7 / SvelteKit 3.0.0 pair. Its integration is covered by tests against the built server. The [OAuth provider patch](../patches/@better-auth__oauth-provider@1.7.7.patch) removes incompatible optional `undefined` declarations from generated OpenAPI types without changing runtime JavaScript. Review these exceptions when upgrading.

The TypeScript version remains 6.0.3 for the selected Svelte compiler integration. Keep compiler upgrades covered by the starter and control-plane checks.

The starter checks authored TypeScript and Svelte sources. JavaScript checking is disabled there because Wrangler's generated `GlobalProps` imports the adapter's generated Worker bundle; checking that JavaScript would re-check bundled dependencies as application source. All `strictest` TypeScript options remain enabled.

## CI and releases

The [check workflow](../.github/workflows/check.yaml) and its [reusable suites](../.github/workflows/check-suites.yaml) define required verification. PR jobs receive read-only cache access; only checks triggered by pushes to `main` can save caches. Test jobs use disposable services and synthetic fixtures.

For publication and recovery, follow [CLI releases](cli-releases.md), [container releases](container-releases.md) or [runtime releases](runtime-releases.md). For website changes, use [documentation site maintenance](documentation-site.md).
