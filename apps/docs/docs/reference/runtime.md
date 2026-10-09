---
title: Application runtime
description: Runtime versions, activation, recovery, storage and supported app APIs.
---

One default celld fleet runs the installation's apps and previews as separate Dynamic Workers. The current installer manages one node. Fleet identity is stored in PostgreSQL and remains unchanged when an executor is registered, disabled or replaced. The executor needs access to the same Docker host, persistent node state, routing directory and fleet storage; registering a new token does not create a new fleet or copy data to another host.

## Versions and updates

The Widefleet loader and built-in binding adapters are JavaScript built from `packages/app-runtime`. They are versioned separately from the Rust agent. `widefleet runtime update VERSION` downloads the matching `runtime-vVERSION` GitHub release and verifies its published checksum. The CLI uploads the package through the authenticated API; operators do not handle release files manually. If the release repository requires authentication, supply a repository-read token using `GH_TOKEN` or `GITHUB_TOKEN`. That token is used only for GitHub; the Widefleet credential is used only for the management API.

```sh
widefleet login
widefleet runtime status
widefleet runtime update VERSION
widefleet runtime rollback PREVIOUS_VERSION
```

Use the normal login with administrator membership and `platform:read platform:write`. `status` reports the selected version, last acknowledged active version, latest update state and stored versions. Update and rollback wait for the executor's result; `--no-wait` returns after queueing. Failed activation returns a nonzero exit status. Rollback selects an already stored version without downloading it again. A newer submitted update stops an older CLI waiter with an explicit message.

The control plane keeps package bytes in Object Storage and only checksums/version references in PostgreSQL. Published versions are immutable. The installed package, app snapshots and native deployment are persisted in fleet storage. A runtime update has its own fleet job and works before any app exists, installing only the requested release. Rollback requires a previously installed release. The first app deployment can initialize the runtime from the release bundled with the control-plane distribution; later control-plane upgrades do not silently change an existing fleet's selected runtime.

If an update returns `409: Runtime versions are immutable`, the installation already stores different bytes under that version. This can happen when a source checkout builds a modified runtime without changing its version, including changes to bundled license notices. Use a matching published platform build or a newly versioned runtime release; do not overwrite stored packages or edit their checksums. `runtime rollback` selects the installation's existing package, not the download from GitHub.

The current bundled release is 0.2.1, using installation protocol 1 for celld 0.6.2. The control plane and agent require that celld version in runtime packages. Workflow support additionally requires a deployment agent that provisions Workflow protocol 1 bindings. A compatible loader/adapter update within installed capabilities needs no Rust rebuild; a new installation protocol or celld binary requires a separately reviewed platform update.

Runtime 0.2.1 forwards incoming HTTP request cancellation explicitly to the loaded app. If the client disconnects before response headers, the app's `request.signal` is aborted. App code must pass that signal to any downstream requests it wants to cancel, for example `env.SERVICE.fetch(url, { signal: request.signal })`. A timeout after a fetch has returned still needs explicit cancellation of the response body; forwarding the incoming signal does not change that celld behavior.

## Activation and recovery

App code is selected through immutable snapshots. The loader binds only the app's declared D1, R2, KV, Queue, asset and plain-text resources. Equal resource names in different apps resolve to different native resources. Previews use the same fleet with their own app identity and data. Resources are created only when declared.

An app-code update can select a new snapshot without a native reload. Changes to native resources, event subscriptions or runtime code also publish and reload celld configuration. The installer validates the candidate before publishing its host reference. Runtime updates evaluate every published app snapshot before acceptance. Requests already using an older snapshot can finish on it. Native reloads retain the old generation during transition; long-lived connections remain subject to celld's generation drain behavior.

Activation uses a persistent journal. Rejected runtime updates restore the last serving native deployment so a subsequent cold restart uses that version. If an executor is interrupted mid-activation, the next executor recovers the journal before doing new work. For an interrupted update, allow that recovery to complete before deliberately restarting the node. Successfully published apps and ordinary node restarts require neither management nor a running executor; proxy, SSO/identity service and fleet storage remain operational dependencies.

Cron schedule and queue attachment changes use two native phases: validate new resources with the published apps’ previous schedules and subscriptions, then select the app and final schedules/subscriptions. Removed consumers are detached before removing their code. Newly attached, unpaused queues are resumed through celld's supported queue command so existing backlog is delivered. Intentionally paused queues remain paused.

## Compatibility and current limits

The [celld/Cloudflare comparison](/reference/runtime-compatibility) separates native differences from Widefleet implementation choices.

| Facility         | Behavior                                                                                                                                                                                                                                                                                |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1               | Prepared statements, batch transactions, raw rows and sessions are forwarded. `dump()` is unsupported by celld 0.6.1.                                                                                                                                                                   |
| R2               | Bodies, metadata, conditions, ranges and multipart uploads are supported. Customer-provided encryption keys are unsupported.                                                                                                                                                            |
| KV               | Text, JSON, bytes, metadata, bulk reads and listing are supported. Streams use the native HTTP service-binding transport because celld 0.6.1 cannot clone streams through custom RPC; celld still buffers values internally.                                                            |
| Cron / Queues    | Declared schedules and consumers call the app's `scheduled`/`queue` handlers, including `waitUntil`, acknowledgment and retry decisions.                                                                                                                                                |
| Telemetry        | App HTTP tails provide console logs and exceptions. celld's Dynamic Worker tails do not cover RPC, Cron or Queue executions; native distributed traces are not exported through this app channel. See [telemetry](/self-hosting/runtime-logs).                                          |
| Dynamic capacity | celld 0.6.1 has a native limit of 256 loaded dynamic instances per process, with at most 255 from one loader generation. Unreferenced instances are eligible for collection; this is not a limit of 256 registered apps. There is no additional platform cache-size or concurrency cap. |
| Scaling          | One managed node initially; no automatic node provisioning or load balancing. A node failure affects all apps on it.                                                                                                                                                                    |

[App Workflows](/guides/workflows) require a compatible agent and runtime with Workflow support. Native Durable Object namespaces inside dynamic apps are not part of this app contract. [IT connectors](/guides/connectors) run as independent regular Workers and can declare their own Durable Object classes. The trusted loader enforces [backend network permissions and browser CSP](/guides/network).

## App removal

Deletion queues cleanup for the app and all its previews. Each cleanup removes the route, app references, deployment artifacts, snapshots and safely removable R2 objects; unrelated apps and the shared fleet remain running. Native D1/KV/Queue cells may remain without app references because celld 0.6.1 exposes no supported per-app physical purge. Do not delete files owned by a running native cell. Provider snapshots/version history and telemetry retention have their own lifecycle. A complete supported cell-purge path remains unresolved.

The shared-fleet migration intentionally does not convert existing per-app deployments. It stops if the database still contains apps. Use a fresh development installation for this foundation; there is no automatic data migration or downgrade.
