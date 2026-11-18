---
title: External services and HTTPS
description: Configure external PostgreSQL, object storage and automatic HTTPS.
lastModified: 2026-11-18
---

Connect Widefleet to existing PostgreSQL and object storage, and let Traefik
issue certificates automatically. These options use the same maintained Compose
configuration as the [single-host installation](/self-hosting/installation);
you select additional Compose files instead of the local services.

Before you start, provision the host, the database, the object storage, its
access rights and the permanent DNS records. Use the same release, source
checkout and image manifest as in
[Get the release](/self-hosting/installation#get-the-release).

## Select the installation

`COMPOSE_FILE` in the private deployment environment selects the Compose files,
separated by `:`. Always start with `infra/compose.base.yaml`, then add one
storage backend and the options you need:

| File                              | Adds                                                                  |
| --------------------------------- | --------------------------------------------------------------------- |
| `compose.base.yaml`               | Management, shared runtime with app sign-in, Traefik, agent and setup |
| `compose.postgres.yaml`           | Local PostgreSQL; omit it for an external `DATABASE_URL`              |
| `compose.s3.yaml`                 | S3 settings, for external S3 or local RustFS                          |
| `compose.rustfs.yaml`             | Local RustFS; combine it with `compose.s3.yaml`                       |
| `compose.azure.yaml`              | Azure Blob Storage                                                    |
| `compose.gcs.yaml`                | Google Cloud Storage                                                  |
| `compose.storage-credential.yaml` | Read-only credential file for Azure workload identity or GCS          |
| `compose.database-ca.yaml`        | Read-only PostgreSQL CA bundle                                        |
| `compose.acme-cloudflare.yaml`    | Automatic HTTPS with Cloudflare DNS validation                        |
| `compose.telemetry.yaml`          | [Runtime logs](/self-hosting/runtime-logs) with ClickHouse            |

```dotenv
# External PostgreSQL + Azure Blob + automatic HTTPS:
COMPOSE_FILE=infra/compose.base.yaml:infra/compose.azure.yaml:infra/compose.acme-cloudflare.yaml

# External PostgreSQL + GCS with VM identity + your own certificate:
# COMPOSE_FILE=infra/compose.base.yaml:infra/compose.gcs.yaml

# Local PostgreSQL + RustFS + automatic HTTPS:
# COMPOSE_FILE=infra/compose.base.yaml:infra/compose.postgres.yaml:infra/compose.s3.yaml:infra/compose.rustfs.yaml:infra/compose.acme-cloudflare.yaml
```

`infra/compose.yaml`, the default in the example environment, combines the base,
PostgreSQL, S3 and RustFS files. When you add optional files or overrides, list
the files explicitly as above. Leave out `-f` arguments, which would override
`COMPOSE_FILE`.

Fill in only the settings for the selected services and remove unused placeholder
credentials. Keep secrets in the private environment file or the host files named
below, never in checked-in Compose files.

## External PostgreSQL

Create a database and a login that owns it and can create tables, indexes and
the migration schema. Widefleet uses this login to set up and run the database.
PostgreSQL 18 is the tested baseline.

Connect with verified TLS:

```dotenv
DATABASE_URL=postgres://widefleet:URL_ENCODED_PASSWORD@database.example.com:5432/widefleet?sslmode=verify-full
```

`verify-full` checks the certificate chain and the hostname, so use the name the
server certificate covers. For Azure, that is the Flexible Server hostname, such
as `example.postgres.database.azure.com`, also when it resolves to a private
address. URL-encode special characters in the username and password. Keep TLS
verification on: do not use `sslmode=no-verify` or `NODE_TLS_REJECT_UNAUTHORIZED=0`.

For a provider or private CA outside Node's trust store, add
`infra/compose.database-ca.yaml` and set:

```dotenv
DATABASE_CA_HOST_FILE=/absolute/secrets/postgres-ca.pem
DATABASE_URL=postgres://widefleet:URL_ENCODED_PASSWORD@database.example.com:5432/widefleet?sslmode=verify-full&sslrootcert=/run/secrets/postgres-ca.pem
```

For Cloud SQL, connect through a DNS name or IP address that its server
certificate covers, or run a Cloud SQL proxy yourself. Keep server-side TLS
enforcement on and allow the host to reach the database through your network and
firewall rules. During acceptance, check the provider's PostgreSQL version,
extensions, privileges and TLS chain.

## Object storage

Create two buckets or containers, one for artifacts and one for fleet data,
before the first start. Then configure the provider as described in
[storage backends](/self-hosting/storage). With S3, setup creates missing buckets;
with Azure and GCS, it checks that they exist and are accessible.

For Azure:

```dotenv
AZURE_STORAGE_ACCOUNT_NAME=examplestorage
AZURE_STORAGE_CONTAINER=widefleet-artifacts
FLEET_AZURE_CONTAINER=widefleet-fleets
```

Without further settings, Widefleet uses the VM's system-assigned managed
identity. Set `AZURE_CLIENT_ID` for a user-assigned identity, or set only
`AZURE_STORAGE_ACCESS_KEY` to use an account key. The identity needs blob data
access to both containers, and the metadata endpoint must be reachable from the
setup, management, agent and runtime containers.

For GCS, set `GCS_BUCKET` and `FLEET_GCS_BUCKET`. Widefleet uses the VM's attached
service account by default; give it object and bucket-metadata permissions. Use
an attached service account or a service-account key file; external-account
(Workload Identity Federation) credential files are not supported.

For a credential file, add `compose.storage-credential.yaml`, set
`FLEET_CREDENTIAL_HOST_FILE` to its absolute path on the Docker host and point
the provider at the mounted path:

- GCS: `GOOGLE_APPLICATION_CREDENTIALS=/run/widefleet/storage-credential`
- Azure workload identity: `AZURE_FEDERATED_TOKEN_FILE=/run/widefleet/storage-credential`,
  plus `AZURE_CLIENT_ID` and `AZURE_TENANT_ID`

The file must exist before start and be readable by the management container's
`node` user and the agent and runtime users; with rootless Docker, check the
mapped IDs. See [credential files](/self-hosting/storage#credential-files) for
rotation.

For external S3, set `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `FLEET_S3_BUCKET`,
`S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY`, and omit `compose.rustfs.yaml`.
Set `FLEET_RUNTIME_S3_ENDPOINT` only if the runtime container reaches storage
through a different endpoint.

## Automatic HTTPS with Cloudflare

Traefik requests and renews Let's Encrypt certificates through Cloudflare DNS
validation. Only Traefik receives the DNS token.

1. Create two **DNS only** records pointing to the host's static public IP:
   `platform.example.com` and `*.apps.example.com`. Set
   `PLATFORM_URL=https://platform.example.com` and `APP_DOMAIN=apps.example.com`.
   App sign-in uses `auth.apps.example.com`, which the wildcard covers.
2. Create a Cloudflare API token with **Zone / Zone / Read** and
   **Zone / DNS / Edit**, limited to the zones containing these hostnames. Store
   only the token in a private host file that Traefik's container user can read.
   During issuance, Traefik adds and removes temporary `_acme-challenge` TXT
   records; the permanent records stay under your control.
3. Add `infra/compose.acme-cloudflare.yaml` to `COMPOSE_FILE` and set:

   ```dotenv
   CLOUDFLARE_DNS_TOKEN_FILE=/absolute/secrets/cloudflare-dns-token
   ACME_EMAIL=operator@example.com
   ACME_ENVIRONMENT=staging
   ```

4. [Start and verify](#start-and-verify) the installation and check the proxy
   logs for successful issuance. Staging certificates are intentionally untrusted
   by browsers, the CLI and the agent; keep their TLS verification on.
5. Set `ACME_ENVIRONMENT=production` (also the default when unset), then
   recreate management and Traefik before connecting normal clients:

   ```sh
   docker compose --env-file widefleet-images-0.7.6.env --env-file /absolute/path/deployment.env up -d control-plane
   docker compose --env-file widefleet-images-0.7.6.env --env-file /absolute/path/deployment.env up -d --force-recreate proxy
   ```

Traefik requests one certificate for management and `*.APP_DOMAIN`. A nested
preview such as `review.notes.apps.example.com` also needs
`*.notes.apps.example.com`; Traefik requests it when the app's first nested
preview is deployed, so HTTPS for that preview can follow shortly after the
deployment succeeds. Organizations with a hostname suffix use
[flat preview addresses](/reference/previews#organization-addresses), which
`*.APP_DOMAIN` already covers. Nested previews use the same sign-in as their app.

The `*.apps.example.com` DNS record also resolves deeper preview names. If you
have explicit records such as `notes.apps.example.com`, also add
`*.notes.apps.example.com` pointing to the host.

The `acme` volume holds the ACME account keys and certificates, in separate
`staging.json` and `production.json` files. Back it up encrypted, keep it out of
Git, and give each running Traefik instance its own account file. Monitor proxy
logs and certificate expiry so you notice failed renewals.

To use Cloudflare's proxy instead of **DNS only**, you also need edge certificates
for the deeper app hostnames; Universal SSL for `example.com` does not cover
`app.apps.example.com`. See [wildcard DNS](https://developers.cloudflare.com/dns/manage-dns-records/reference/wildcard-dns-records/)
and [Universal SSL limits](https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/limitations/).

### Your own certificate

Without the ACME file, Traefik serves `fullchain.pem` and `privkey.pem` from
`${PLATFORM_DATA_DIRECTORY}/tls`. The certificate must be trusted by clients and
cover management, the app wildcard and any nested preview hosts or their parent
wildcards. After replacing the files, recreate Traefik with
`docker compose ... up -d --force-recreate proxy`. A Cloudflare Origin CA
certificate works only behind Cloudflare's proxy, not for direct browser and CLI
connections.

## Start and verify

Create the data directory with its `agent` and `tls` subdirectories. For local
PostgreSQL or RustFS, also prepare their directories and ownership as in
[Prepare the data directory](/self-hosting/installation#prepare-the-data-directory).
Place credential, CA and token files before starting the services that use them.

1. Pull the images and validate the configuration:

   ```sh
   docker compose --env-file widefleet-images-0.7.6.env --env-file /absolute/path/deployment.env --profile agent pull
   docker compose --env-file widefleet-images-0.7.6.env --env-file /absolute/path/deployment.env config --quiet
   ```

   A full `docker compose config` output shows secrets; keep it private.

2. Check that the external services are reachable, then start the platform:

   ```sh
   docker compose --env-file widefleet-images-0.7.6.env --env-file /absolute/path/deployment.env up -d control-plane proxy
   docker compose --env-file widefleet-images-0.7.6.env --env-file /absolute/path/deployment.env ps --all
   ```

3. With ACME, complete the staging and production certificate steps above.
4. Check that `https://platform.example.com/healthz` responds, then
   [complete first setup](/self-hosting/installation#complete-first-setup) and
   [connect the deployment agent](/self-hosting/installation#connect-the-deployment-agent).
5. Accept the installation: log in with the CLI, deploy an app, sign in to it,
   write and read D1 and R2 data, and repeat the reads after restarting the
   runtime. Check that unselected local PostgreSQL and RustFS containers are absent
   and that only ports 80 and 443 are public.

After changing the TLS mode or ACME environment later, recreate management and
Traefik as in step 5 of [automatic HTTPS](#automatic-https-with-cloudflare). ACME
account state and generated app routes stay in their named volumes. Company
sign-in is configured in management, independently of these settings; see
[sign-in and settings](/self-hosting/sign-in-and-settings).
