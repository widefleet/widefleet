---
title: External services and HTTPS
description: Configure external PostgreSQL, object storage and automatic HTTPS.
---

These are maintained installation configurations, shared with the local PostgreSQL/RustFS reference installation. They do not provision VMs, cloud databases, object stores, IAM or permanent DNS records. Bicep/Terraform deployment templates are not included. Use Linux x86-64, the supported Docker baseline from [operations](/self-hosting/installation), and Docker Compose 2.20.0 or newer.

Use release `v0.1.8` or newer with its matching source checkout and image manifest. The `v0.1.7` images predate native Azure/GCS storage and the new edge configurator; do not use them with these service files. See the [operations guide](/self-hosting/installation#pull-the-release-images) for downloading and verifying the release manifest.

## Select the installation

Copy `infra/deployment.env.example` to a private file outside Git and fill the authentication, image-independent platform, and selected provider settings. Remove unused placeholder credentials. Secrets belong in this private file or the specified host files, never in checked-in Compose files. Keep running Compose from the repository root.

`COMPOSE_FILE` in that private env file selects the maintained configurations, separated by `:` on the supported Linux host. Always start with `infra/compose.base.yaml`. Select one storage backend and optionally local PostgreSQL:

| File                              | Purpose                                                             |
| --------------------------------- | ------------------------------------------------------------------- |
| `compose.base.yaml`               | Management, app SSO, Traefik, agent and configuration tool          |
| `compose.postgres.yaml`           | Add local PostgreSQL; omit for an external `DATABASE_URL`           |
| `compose.s3.yaml`                 | S3 settings for external storage or local RustFS                    |
| `compose.rustfs.yaml`             | Add local RustFS; combine with `compose.s3.yaml`                    |
| `compose.azure.yaml`              | Native Azure Blob settings, with no local object-store service      |
| `compose.gcs.yaml`                | Native GCS settings, with no local object-store service             |
| `compose.storage-credential.yaml` | Read-only credential-file mounts for Azure workload identity or GCS |
| `compose.database-ca.yaml`        | Read-only PostgreSQL CA-bundle mount                                |
| `compose.acme-cloudflare.yaml`    | Automatic HTTPS using Cloudflare DNS validation                     |
| `compose.telemetry.yaml`          | ClickHouse and an internal OpenTelemetry Collector for runtime logs |

Examples for the private env file:

```dotenv
# External PostgreSQL + Azure Blob + Cloudflare/Let's Encrypt:
COMPOSE_FILE=infra/compose.base.yaml:infra/compose.azure.yaml:infra/compose.acme-cloudflare.yaml

# External PostgreSQL + GCS with VM identity + supplied certificates:
# COMPOSE_FILE=infra/compose.base.yaml:infra/compose.gcs.yaml

# Local PostgreSQL + RustFS + automatic HTTPS:
# COMPOSE_FILE=infra/compose.base.yaml:infra/compose.postgres.yaml:infra/compose.s3.yaml:infra/compose.rustfs.yaml:infra/compose.acme-cloudflare.yaml
```

`infra/compose.yaml` remains the original local-service entry point, implemented as an include of the base, PostgreSQL, S3 and RustFS files. Use the explicit base/file selections above when adding optional configurations; do not layer service overrides over the include wrapper. Explicit `-f` arguments override `COMPOSE_FILE`, so omit them when using this env-file selection.

All commands must receive the same image manifest and private environment. Below, `release-images.env` means the matching downloaded image manifest (or locally built image references); `/absolute/deployment.env` is your private configuration. `docker compose config` can display secrets: use `config --quiet` for validation and keep any full rendering private.

For runtime error history and `widefleet logs`, add `compose.telemetry.yaml` and follow [telemetry setup](/self-hosting/runtime-logs). This requires updated management, CLI and agent builds, two ClickHouse credentials and persistent telemetry directories. App hooks and runtime export become active through an explicit app redeployment.

## External PostgreSQL

Provision a PostgreSQL database and a login that owns that database and can create tables, indexes and the migration schema. Management runs the checked-in migrations and idempotently registers the CLI OAuth client; no cloud-superuser role is required. The reference uses one database owner for initialization and runtime. Separate migration and runtime roles remain a future hardening option.

Use verified TLS explicitly:

```dotenv
DATABASE_URL=postgres://widefleet:URL_ENCODED_PASSWORD@database.example.com:5432/widefleet?sslmode=verify-full
```

For Azure, use the actual Flexible Server DNS hostname (for example `example.postgres.database.azure.com`), including when it resolves to a private address. `verify-full` validates both the certificate chain and the hostname. Encode special characters in the username/password. Do not use `sslmode=no-verify` or `NODE_TLS_REJECT_UNAUTHORIZED=0`.

For a provider/private CA that is not in Node's trust store, add `infra/compose.database-ca.yaml` and configure:

```dotenv
DATABASE_CA_HOST_FILE=/absolute/secrets/postgres-ca.pem
DATABASE_URL=postgres://widefleet:URL_ENCODED_PASSWORD@database.example.com:5432/widefleet?sslmode=verify-full&sslrootcert=/run/secrets/postgres-ca.pem
```

Use the certificate's matching DNS name. Cloud SQL connections to an IP address require a server certificate that can be verified for that IP or a supported DNS name and network path. A Cloud SQL connector/proxy is not bundled. Keep server-side TLS enforcement enabled and allow the host network access to the database. Private networking and firewall rules are operator responsibilities.

The external server must support the SQL in our migrations. PostgreSQL 18 is the tested baseline; Azure/GCP versions, extensions, privileges and provider-specific TLS chains require the real-cloud acceptance test. No runtime connection code bypasses TLS validation.

## Object storage

Provision separate artifact and fleet containers/buckets before initialization. Configure the selected provider using [storage backends](/self-hosting/storage). Azure/GCS initialization verifies their existence and access; it does not create cloud resources. S3 initialization retains its existing behavior of creating missing buckets.

For Azure:

```dotenv
AZURE_STORAGE_ACCOUNT_NAME=examplestorage
AZURE_STORAGE_CONTAINER=widefleet-artifacts
FLEET_AZURE_CONTAINER=widefleet-fleets
```

Omit identity/key variables for a system-assigned VM managed identity. Set `AZURE_CLIENT_ID` for a user-assigned identity. Alternatively, set only `AZURE_STORAGE_ACCESS_KEY` for account-key authentication. The identity needs blob data access to the containers, and its metadata endpoint must be reachable from management, agent and app containers.

For GCS, set `GCS_BUCKET` and `FLEET_GCS_BUCKET`. An attached VM service account is the default. Give it the required object and bucket-metadata permissions. GCS external-account / Workload Identity Federation credential files remain unsupported by the pinned fleet clients.

For file credentials, add `compose.storage-credential.yaml` and set `FLEET_CREDENTIAL_HOST_FILE` to the actual absolute path on the Docker host. Set the provider's container path to `/run/widefleet/storage-credential`:

- GCS: `GOOGLE_APPLICATION_CREDENTIALS=/run/widefleet/storage-credential`.
- Azure workload identity: `AZURE_FEDERATED_TOKEN_FILE=/run/widefleet/storage-credential`, plus `AZURE_CLIENT_ID` and `AZURE_TENANT_ID`.

The file must exist and be readable by the management container's `node` user and the agent/runtime users. Check mapped IDs for rootless Docker. Mounts are read-only and fail if the host path is absent. The agent receives the host path for its runtime mounts. Preserve the inode during token refresh; atomic file replacement requires recreating affected containers, as described in [storage backends](/self-hosting/storage).

For external S3, set `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `FLEET_S3_BUCKET`, `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY`. `FLEET_RUNTIME_S3_ENDPOINT` is only needed if app containers use a different endpoint. Omit `compose.rustfs.yaml`. Only local RustFS configurations attach the storage container to each app network.

## Automatic HTTPS with Cloudflare

Set up two DNS records pointing to the host's static public IP: `platform.example.com` and `*.apps.example.com`. Use `PLATFORM_URL=https://platform.example.com` and `APP_DOMAIN=apps.example.com`. The two Entra callback URLs are shown during [first setup](/self-hosting/installation#infrastructure-and-first-start); they do not change when adding apps. Management must be outside `APP_DOMAIN`. App SSO uses `auth.apps.example.com`, already covered by the wildcard.

Use Cloudflare **DNS only** for the direct Traefik setup. Cloudflare supports deeper wildcard DNS records on all plans. Its normal Universal SSL coverage for `example.com` does not cover `app.apps.example.com` when proxying; an orange-cloud deployment needs suitable edge certificates as well as origin TLS. See [wildcard DNS](https://developers.cloudflare.com/dns/manage-dns-records/reference/wildcard-dns-records/) and [Universal SSL limits](https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/limitations/).

Create a Cloudflare API token with **Zone / Zone / Read** and **Zone / DNS / Edit**, scoped only to the zone(s) containing management and app hostnames. Store the token alone in a private host file, readable by Traefik's container user; keep the token out of Compose command arguments. The ACME configuration mounts it only into Traefik through `CF_DNS_API_TOKEN_FILE`. See the [Cloudflare DNS provider](https://go-acme.github.io/lego/dns/cloudflare/).

```dotenv
CLOUDFLARE_DNS_TOKEN_FILE=/absolute/secrets/cloudflare-dns-token
ACME_EMAIL=operator@example.com
ACME_ENVIRONMENT=staging
```

Add `compose.acme-cloudflare.yaml` and start the selected services. Management generates the edge configuration at startup. Issuance uses DNS-01; Traefik creates and removes temporary `_acme-challenge` TXT records through its configured provider. Permanent DNS routing records remain operator-managed through the versioned DNS configuration/deployment process. Starting Traefik in this mode performs external certificate/DNS operations; rendering the configuration itself does not contact Cloudflare.

Check issuance using the staging CA first. Its certificates are intentionally not trusted by browsers, the CLI or the agent. Do not weaken their TLS verification to finish a staging installation. After checking issuance logs, set `ACME_ENVIRONMENT=production`, recreate management to render the static configuration, then recreate Traefik before starting normal clients. The default when the variable is omitted is `production`.

Traefik requests management and `*.APP_DOMAIN` together. Regular app routes use that certificate store. A nested [preview](/reference/previews) additionally requests `*.<parent-app>.APP_DOMAIN`; all previews of that parent share the certificate. The ACME overlay passes `TLS_MODE=cloudflare` to the agent, and the base Compose configuration supplies `APP_DOMAIN`. Issuance and renewal are handled by Traefik's built-in [ACME resolver](https://doc.traefik.io/traefik/reference/install-configuration/tls/certificate-resolvers/acme/).

The persistent named volume `acme` holds separate `staging.json` and `production.json` files with ACME account keys and certificates. Traefik owns renewal and creates its files with mode `0600`. Back up this volume encrypted, keep it out of Git, and do not share one account file between simultaneously running Traefik instances. Monitor proxy logs and certificate expiration; failed renewals need operator attention.

Omit the ACME file to use existing certificates. Place `fullchain.pem` and `privkey.pem` under `${PLATFORM_DATA_DIRECTORY}/tls`. The certificate must cover both management and the app wildcard, plus the nested preview hosts or their parent wildcards when used, and the chain must be trusted by clients. Recreate Traefik after replacing supplied certificate files. A Cloudflare Origin CA certificate is suitable only behind its proxy, not for direct browser/CLI connections.

## Start and verify

Create the host data directory and `agent` and `tls` subdirectories. Widefleet uses named volumes for keys, generated configuration and ACME state. For local services, also prepare the PostgreSQL/RustFS paths and ownership from [operations](/self-hosting/installation). Place external credential/CA/token files before starting their consumers.

```sh
docker compose --env-file release-images.env --env-file /absolute/deployment.env --profile agent --profile images pull
docker compose --env-file release-images.env --env-file /absolute/deployment.env config --quiet
```

If selected, start local PostgreSQL and/or RustFS before initialization. For entirely external services, both should already be reachable:

```sh
docker compose --env-file release-images.env --env-file /absolute/deployment.env run --rm --no-deps control-plane node tools/initialize-storage.ts
docker compose --env-file release-images.env --env-file /absolute/deployment.env up -d control-plane oauth2-proxy proxy
```

Complete the staging/production certificate check if using ACME. Then verify `https://platform.example.com/healthz`, sign in to management, register the agent, and store its returned token in the private environment file. Start the agent:

```sh
docker compose --env-file release-images.env --env-file /absolute/deployment.env --profile agent up -d agent
```

Acceptance: log in with the CLI, deploy an app, complete app SSO, write/read D1 and R2 data, and repeat those reads after a normal runtime restart. Check that selected external services are used and that PostgreSQL/RustFS containers are absent when not selected. Only ports 80/443 are public. Startup initializes the management database schema; actual deployment exercises storage separately.

Restart Traefik after infrastructure changes to TLS mode or ACME environment. Keep generated app routes and ACME account state in their named volumes. Product SSO settings are managed through the UI/API, independently of these deployment settings. See [first setup and recovery](/self-hosting/installation).

## Verification boundary

Run `RUN_INSTALLATION_TESTS=1 pnpm exec vitest run apps/control-plane/tests/installation` to validate the Compose combinations, credential isolation, PostgreSQL TLS rejection cases and repeatable migrations, and certificate loading/restart with the pinned Traefik image. These tests use synthetic credentials, temporary containers and locally generated certificates. The Traefik fixture has no external network and uses a preloaded test ACME certificate; it does not prove real certificate issuance or renewal.

Cloud acceptance with release `v0.1.8` and CLI `0.1.5` verified the Azure configuration: private PostgreSQL 18 with `verify-full`, system-assigned VM identity with container-scoped Blob data permissions, management and app Entra login, OAuth device authorization, and a CLI deployment using native Azure artifacts and fleets. D1 notes and R2 images remained readable after a normal app-container restart with its existing data disk; the image bytes matched before and after restart. Cloudflare DNS-01 issuance succeeded against both the staging and production Let's Encrypt CAs, and public HTTPS passed certificate verification.

This acceptance does not establish certificate renewal, recovery after losing the data disk, other Azure credential modes, or real GCS authentication/deployment. Those remain separate acceptance checks. The local `./dev` experience and existing S3 deployment tests remain available without cloud accounts.
