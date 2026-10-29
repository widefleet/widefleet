---
title: Storage backends
description: Configure artifact and fleet storage, credentials and existing data.
lastModified: 2026-10-23
---

The control plane and deployment agent support S3-compatible storage, Azure Blob Storage and Google Cloud Storage. S3 remains the default when the provider variables are omitted. The default Compose installation uses RustFS. Maintained [Compose service selections](/self-hosting/external-services) connect the same installation to existing external S3, Azure Blob or GCS resources. See [initialization and existing data](#initialization-and-existing-data) when changing storage.

| Backend              | Control plane            | Fleet runtime                |
| -------------------- | ------------------------ | ---------------------------- |
| S3 / RustFS          | AWS S3 SDK               | Native `s3://` through celld |
| Azure Blob           | Azure Blob SDK           | Native `az://` through celld |
| Google Cloud Storage | Google Cloud Storage SDK | Native `gs://` through celld |

The control plane stores uploaded modules and assets. The agent publishes them into a separate fleet bucket/container, where celld also persists D1 and R2 data. App artifacts use `apps/<app-id>/`; runtime packages use `packages/sha256/<checksum>.json`. Starting with platform 0.4.0, runtime state uses `organizations/<organization-id>/`, independently of executor registration. App-owned resource identities include the app UUID, so equal resource names in two apps stay separate. PostgreSQL holds runtime versions and checksums, not package bodies. App code and the CLI upload contract are independent of the selected backend. PostgreSQL and local runtime state still require their own storage.

## Control plane configuration

Set `ARTIFACT_STORAGE_PROVIDER` to `s3`, `azure` or `gcs`. Configure only the selected backend. These variables supplement the existing database, authentication and platform settings.

| Provider       | Required settings                                                      | Optional settings                                               |
| -------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------- |
| `s3` (default) | `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | `S3_REGION` (default `us-east-1`)                               |
| `azure`        | `AZURE_STORAGE_ACCOUNT_NAME`, `AZURE_STORAGE_CONTAINER`                | Azure credentials described below                               |
| `gcs`          | `GCS_BUCKET`                                                           | `GOOGLE_APPLICATION_CREDENTIALS`: absolute credential file path |

Azure supports the public Azure cloud. Authentication uses exactly one of:

- An account key in `AZURE_STORAGE_ACCESS_KEY`.
- Managed identity, with optional `AZURE_CLIENT_ID` to select a user-assigned identity.
- Workload identity, with all three of `AZURE_CLIENT_ID`, `AZURE_TENANT_ID` and `AZURE_FEDERATED_TOKEN_FILE`.

Account keys cannot be combined with identity settings. The SDK uses the selected identity directly; it does not fall back to a developer's Azure CLI login. SAS URLs, arbitrary Blob endpoints and sovereign Azure authorities are outside this configuration contract.

GCS uses Application Default Credentials (ADC). For a portable file-based configuration, supply a service-account JSON file through `GOOGLE_APPLICATION_CREDENTIALS`. Without an explicit file, ADC resolves in each process's environment, including an attached VM service account where available. Ensure the control plane, agent and app runtimes have their intended identities. The current Rust clients do not support every ADC credential-file type; external-account / Workload Identity Federation files are not a supported fleet configuration.

## Agent and runtime configuration

Set `FLEET_STORAGE_PROVIDER` independently to `s3`, `azure` or `gcs`; it also defaults to `s3`.

| Provider | Required settings                                                                                       | Optional settings                                                    |
| -------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `s3`     | Existing `FLEET_S3_ENDPOINT`, `FLEET_S3_BUCKET`, `FLEET_S3_ACCESS_KEY_ID`, `FLEET_S3_SECRET_ACCESS_KEY` | `FLEET_S3_REGION` (default `us-east-1`), `FLEET_RUNTIME_S3_ENDPOINT` |
| `azure`  | `AZURE_STORAGE_ACCOUNT_NAME`, `FLEET_AZURE_CONTAINER`                                                   | Same Azure credential settings as above                              |
| `gcs`    | `FLEET_GCS_BUCKET`                                                                                      | `GOOGLE_APPLICATION_CREDENTIALS`                                     |

The agent rejects settings for an unselected provider. It supplies the native bucket scheme and only that backend's credentials to celld. Azure/GCS invocations have no S3 endpoint, region or keys. The agent's app-scoped cleanup uses the same backend while preserving the shared fleet prefix.

When authentication uses `AZURE_FEDERATED_TOKEN_FILE` or `GOOGLE_APPLICATION_CREDENTIALS`, also set `FLEET_CREDENTIAL_HOST_FILE` to the absolute path of that same file on the Docker host. The agent-visible path and host path can differ when the agent runs in a container. The agent checks its local file before processing jobs. The Compose credential overlay mounts the host file read-only at `/run/widefleet/storage-credential` in the shared runtime and the services that need storage access. The file is not copied into an artifact or Docker image. Credential refresh must preserve the mounted file's inode; replacing the host file atomically requires recreating the affected containers. Container recreation for credential rotation is an operator procedure, not automated here.

Without a credential file, managed/VM identity endpoints must be reachable from both the agent and fleet runtime containers. Cloud network and IAM configuration remain operator responsibilities. App-scoped bindings separate resource access while celld uses shared fleet credentials.

## Initialization and existing data

Artifact uploads are create-only: writing an existing key preserves its original bytes and succeeds. Runtime packages use content-addressed keys, so retries and concurrent uploads can safely reuse them. Object Storage is outside the PostgreSQL transaction; a failed transaction can leave an unreferenced package, which a later retry reuses without deleting it. Other storage errors fail the operation before a database reference is committed.

The Compose `initialize` service creates missing S3 buckets. In Azure/GCS mode it only checks existing artifact and fleet containers/buckets; missing resources are an error. It does not create storage accounts, cloud buckets, identities or IAM bindings. This tool expects matching artifact/fleet providers and access to both locations using the control plane's credentials. The fleet name comes from `FLEET_AZURE_CONTAINER` or `FLEET_GCS_BUCKET`.

Changing a provider, bucket, endpoint or account is not a data migration. Before publishing or deleting an app with an existing runtime container, the agent checks that the configured fleet location matches that container. A mismatch stops the job before publishing data or removing the container. No automatic migration of stored artifacts, D1/R2 data or existing runtime containers is included. Preserve the matching storage settings for all existing apps until a migration procedure has been designed and verified.

Object versions, snapshots, soft-deleted objects and retention policies are managed by the storage operator. App deletion removes routes, app snapshots, artifact files and declared R2 objects. Native D1/KV/queue cells can remain after their app references are removed: celld 0.6.1 has no supported per-app physical purge in a shared fleet. Do not delete live cell files manually. Provider-retained historical versions also remain governed by the storage provider. Cloud replication and soft deletion do not replace a coordinated backup of PostgreSQL, fleet storage and local runtime state.

For installation checks, follow [start and verify](/self-hosting/external-services#start-and-verify).
