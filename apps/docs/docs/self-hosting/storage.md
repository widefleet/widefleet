---
title: Storage backends
description: Configure artifact and fleet storage, credentials and existing data.
lastModified: 2026-11-18
---

Widefleet stores files in two locations on S3-compatible storage, Azure Blob
Storage or Google Cloud Storage:

- The **artifact** bucket holds uploaded app code, assets, source maps and runtime
  packages. Management and the agent use it.
- The **fleet** bucket holds app data (D1, R2, KV and queues), published app
  snapshots and the generated key for app secrets. The agent and the runtime use it.

The default installation uses local RustFS through S3. Apps work the same on
every backend. Back up both locations together with PostgreSQL and the runtime
state; see [backup and restore](/self-hosting/operations#back-up-and-restore).
To select a backend with Compose, see
[external services](/self-hosting/external-services#object-storage).

## Control plane configuration

Set `ARTIFACT_STORAGE_PROVIDER` to `s3` (the default), `azure` or `gcs`, and
configure only that provider:

| Provider       | Required settings                                                      | Optional settings                                               |
| -------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------- |
| `s3` (default) | `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | `S3_REGION` (default `us-east-1`)                               |
| `azure`        | `AZURE_STORAGE_ACCOUNT_NAME`, `AZURE_STORAGE_CONTAINER`                | Azure credentials described below                               |
| `gcs`          | `GCS_BUCKET`                                                           | `GOOGLE_APPLICATION_CREDENTIALS`: absolute credential file path |

For Azure, use the public Azure cloud with a storage account name. SAS URLs,
custom Blob endpoints and sovereign clouds are not supported. Set exactly one
authentication method:

- An account key in `AZURE_STORAGE_ACCESS_KEY`.
- Managed identity, with optional `AZURE_CLIENT_ID` to select a user-assigned identity.
- Workload identity, with all three of `AZURE_CLIENT_ID`, `AZURE_TENANT_ID` and `AZURE_FEDERATED_TOKEN_FILE`.

Widefleet uses the configured identity only; a developer's Azure CLI login is never
used.

GCS uses Application Default Credentials. Supply a service-account JSON file
through `GOOGLE_APPLICATION_CREDENTIALS`, or omit it to use each container's
environment, such as an attached VM service account. Make sure management, the
agent and the runtime each have their intended identity. External-account
(Workload Identity Federation) credential files are not supported.

## Agent and runtime configuration

Set `FLEET_STORAGE_PROVIDER` to `s3` (the default), `azure` or `gcs`,
independently of the control plane:

| Provider | Required settings                                                                              | Optional settings                                                    |
| -------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `s3`     | `FLEET_S3_ENDPOINT`, `FLEET_S3_BUCKET`, `FLEET_S3_ACCESS_KEY_ID`, `FLEET_S3_SECRET_ACCESS_KEY` | `FLEET_S3_REGION` (default `us-east-1`), `FLEET_RUNTIME_S3_ENDPOINT` |
| `azure`  | `AZURE_STORAGE_ACCOUNT_NAME`, `FLEET_AZURE_CONTAINER`                                          | Same Azure credential settings as above                              |
| `gcs`    | `FLEET_GCS_BUCKET`                                                                             | `GOOGLE_APPLICATION_CREDENTIALS`                                     |

Set only the variables for the selected provider; the agent rejects settings for
other providers. Without a credential file, the managed or VM identity endpoint
must be reachable from the agent and runtime containers.

### Credential files

When authentication uses `AZURE_FEDERATED_TOKEN_FILE` or
`GOOGLE_APPLICATION_CREDENTIALS`, also set `FLEET_CREDENTIAL_HOST_FILE` to the
absolute path of the same file on the Docker host. The agent checks the file
before it processes jobs. The Compose credential file mounts it read-only at
`/run/widefleet/storage-credential` in the runtime and the other services that
need storage; it is never copied into an artifact or image.

Update a rotated credential file in place. If your tooling replaces the file
instead, recreate the services that mount it.

## Initialization

On first start, the `initialize` service prepares both locations with the control
plane's credentials. It creates missing S3 buckets. For Azure and GCS, it checks
that the artifact and fleet containers or buckets exist and are accessible; create
storage accounts, buckets, identities and access rights beforehand. The fleet
location comes from `FLEET_AZURE_CONTAINER` or `FLEET_GCS_BUCKET`.

## Existing data

Keep the provider, bucket, endpoint and account unchanged once apps are deployed.
Before each job, the agent checks that the configured fleet location matches the
one the apps use and stops the job if it does not. Widefleet does not move stored
artifacts or app data between locations.

Deleting an app removes its routes, snapshots, artifact files and declared R2
objects. Its D1, KV and queue data files stay in fleet storage. Do not delete
live data files manually.

Object versions, soft deletion and retention follow your storage provider's
policies. They complement, but do not replace, a coordinated backup of
PostgreSQL, both storage locations and the runtime state.

To check the installation, follow
[start and verify](/self-hosting/external-services#start-and-verify).
