---
title: Application runtime
description: Runtime versions, deployments, supported app APIs and app removal.
lastModified: 2026-11-18
---

Each app and each preview runs as its own Dynamic Worker in the installation's
runtime and sees only the resources it declares. This page lists the APIs apps
can use, how deployments take effect and what app removal cleans up. For the
node, storage and recovery setup, see [operations](/self-hosting/operations).

## Versions and updates

The app runtime has the same version as Widefleet. Features such as
[MCP](/guides/mcp) and [workload identities](/guides/workload-identity) need the
matching runtime active. Administrators check and change it with the CLI, using
the Widefleet release version for `VERSION`:

```sh
widefleet login
widefleet runtime status
widefleet runtime update VERSION
widefleet runtime rollback PREVIOUS_VERSION
```

Sign in with administrator membership; the default scopes `platform:read platform:write` are sufficient.

- `status` reports the selected version, the last acknowledged active version, the latest update state and the stored versions.
- `update` downloads the runtime package from the matching `vVERSION` GitHub release, verifies its checksum and activates it.
- `rollback` selects a version the installation already stores, without downloading it again.

Update and rollback wait for the result and exit nonzero if activation fails; `--no-wait` returns after queueing. A newer submitted update stops an older waiting CLI with an explicit message. Activating a runtime is separate from updating container images.

If an update returns `409: Runtime versions are immutable`, the installation already stores different bytes under that version, for example from a source checkout that built a modified runtime (including changed license notices) without changing its version. Use a matching published platform build or a newly versioned runtime release. Do not overwrite stored packages or edit their checksums.

## Request cancellation

The runtime forwards HTTP request cancellation to the app. If the client disconnects before response headers, the app's `request.signal` is aborted. Pass that signal to downstream requests you want to cancel, for example `env.SERVICE.fetch(url, { signal: request.signal })`. A timeout after a fetch has returned still needs explicit cancellation of the response body.

## Deployments and resources

Every deployment selects an immutable snapshot of the app code. Requests already running on the previous snapshot can finish on it.

The app receives only its declared D1, R2, KV, Queue, asset and plain-text bindings. Resources are created when they are first declared. Equal resource names in different apps resolve to different resources, and previews have their own app identity and data.

When a deployment changes Cron schedules or queue consumers, removed consumers are detached before their code is removed. A newly attached queue delivers its existing backlog unless it was paused intentionally; paused queues stay paused.

## Supported app APIs

| Facility         | Behavior                                                                                                                                                                                                              |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1               | Prepared statements, batch transactions, raw rows and sessions. `dump()` is not available.                                                                                                                            |
| R2               | Bodies, metadata, conditions, ranges and multipart uploads. Customer-provided encryption keys are not available.                                                                                                      |
| KV               | Text, JSON, bytes, streams, metadata, bulk reads and listing. Values are buffered in memory.                                                                                                                          |
| Cron / Queues    | Declared schedules and consumers call the app's `scheduled`/`queue` handlers, including `waitUntil`, acknowledgment and retry decisions.                                                                              |
| Telemetry        | Console logs and exceptions from HTTP requests, per app. Cron, Queue and service (RPC) executions do not appear in app logs, and distributed traces are not exported. See [runtime logs](/self-hosting/runtime-logs). |
| Dynamic capacity | Up to 256 loaded dynamic instances per process, with at most 255 from one loader generation. The limit counts loaded instances; unreferenced instances are eligible for collection.                                   |
| Scaling          | Self-hosted installations run all apps on one managed node, without automatic node provisioning or load balancing. All apps share that node's availability, so size, monitor and back it up accordingly.              |

[App Workflows](/guides/workflows) and [app services](/guides/app-services) use the same runtime and resource declarations. Apps cannot declare Durable Object classes. The runtime enforces [backend network permissions and browser CSP](/guides/network). For differences from Cloudflare, see [runtime compatibility](/reference/runtime-compatibility).

## App removal

Deleting an app queues cleanup for the app and all its previews. Cleanup removes the route, app references, deployment artifacts, snapshots and safely removable R2 objects; other apps keep running. D1, KV and Queue storage can remain on the node without app references, because the runtime has no per-app physical purge. Do not delete files owned by a running native cell. Provider snapshots, version history and telemetry retention follow their own lifecycle.
