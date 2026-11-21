---
title: Runtime compatibility
description: Supported runtime integrations and verified differences from Cloudflare.
lastModified: 2026-11-18
---

Widefleet apps use the Cloudflare Workers programming model and run on
**celld 0.6.3-widefleet.1**, a Widefleet build of celld 0.6.3; see the
[native release notes](https://github.com/widefleet/celld/releases/tag/v0.6.3-widefleet.1)
and [platform versions](/self-hosting/operations#versions-and-updates).

## What you can use

| Area                                                                 | Supported                                                                                                                                                              |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [D1, R2, KV, Cron and Queues](/reference/runtime#supported-app-apis) | The Workers binding APIs through app-scoped bindings                                                                                                                   |
| [Workflows](/guides/workflows)                                       | The usual `WorkflowEntrypoint` and step APIs                                                                                                                           |
| [App services](/guides/app-services)                                 | Explicitly declared Worker entrypoints, on celld and Cloudflare                                                                                                        |
| Modules                                                              | ES modules and Wasm; up to 32 runtime modules and 500 source maps, at most 20 MiB per file                                                                             |
| [Node.js APIs](#nodejs-compatibility)                                | Node-aware bundling with `nodejs_compat` and the Node APIs implemented by celld                                                                                        |
| Outbound HTTP                                                        | `fetch()` through the network gateway, subject to [network permissions](/guides/network)                                                                               |
| Execution limits                                                     | [CPU and subrequest budgets](/reference/configuration#dynamic-worker-execution-limits) on Cloudflare installations, in addition to native runtime and transport limits |

## Differences from Cloudflare

| Area                           | Native behavior                                                                                                                                    | Comparison and effect on Widefleet                                                                                                                                                                                                                                               |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dynamic Worker capacity        | At most 256 loaded instances per process, including copies and old generations; at most 255 from one script generation.                            | Cloudflare limits simultaneously active distinct Dynamic Workers per I/O context: four per Worker request and ten per Durable Object. celld counts loaded instances across the process; collection and concurrent load determine how many registered apps fit within that limit. |
| Streams over RPC               | Streams cannot cross isolates through custom RPC; a local Dynamic Worker to service-binding call fails cloning.                                    | Cloudflare RPC supports byte-oriented readable/writable streams with flow control. Widefleet uses native Fetcher service bindings for individual KV and R2 values while preserving the public app API.                                                                           |
| Streams over service `fetch()` | Host-backed HTTP bodies can be forwarded. JavaScript-created streams are fully buffered when crossing isolates.                                    | Cloudflare supports streaming request/response bodies. In Widefleet, `KV.put(key, request.body)` avoids an extra full adapter buffer for host-backed bodies.                                                                                                                     |
| Forwarded RPC stubs            | An RPC stub cannot cross an isolate boundary; a loaded Worker entrypoint cannot be passed to another Worker.                                       | Cloudflare supports forwarding received stubs. Widefleet supports direct calls through granted service bindings.                                                                                                                                                                 |
| Dynamic Worker tails           | Tails cover `fetch`, not RPC, with at most 256 KiB of serialized console logs per call.                                                            | Widefleet's Cron/Queue calls are delivered over RPC and therefore do not appear in app tails.                                                                                                                                                                                    |
| Controlled outbound traffic    | A `globalOutbound` Fetcher cannot proxy TCP `connect()` or outgoing WebSockets; these calls fail.                                                  | Cloudflare documents proxying `fetch()` and `connect()`. Widefleet brokers HTTP requests through its network gateway.                                                                                                                                                            |
| KV storage                     | A namespace is a cell with one owner. No edge cache; `cacheTtl` has no effect and `cacheStatus` is `null`. Native processing still buffers values. | Cloudflare KV uses geographically distributed caches with different consistency and latency.                                                                                                                                                                                     |
| R2                             | No `ssecKey` or `jurisdiction`; conditional writes from streams larger than 8 MiB are unsupported.                                                 | Widefleet forwards supported R2 operations through app-scoped bindings; see the [runtime reference](/reference/runtime#supported-app-apis).                                                                                                                                      |
| D1 export                      | `dump()` throws.                                                                                                                                   | Cloudflare also restricts `dump()` to databases from its D1 alpha period.                                                                                                                                                                                                        |
| Data modules                   | Separate text and binary data modules are rejected with “must be a string or wasm bytes”.                                                          | Local `workerd` loads them. Use ES modules or Wasm instead.                                                                                                                                                                                                                      |

Sources: [celld Dynamic Workers](https://github.com/widefleet/celld/blob/v0.6.3-widefleet.1/docs/services/dynamic-workers.md), [celld RPC and streams](https://github.com/widefleet/celld/blob/v0.6.3-widefleet.1/docs/cloudflare-compat.md#rpc), [native stream transfer](https://github.com/widefleet/celld/blob/v0.6.3-widefleet.1/crates/celld/js/harness.js#L3592), [KV](https://github.com/widefleet/celld/blob/v0.6.3-widefleet.1/docs/services/kv.md), [R2](https://github.com/widefleet/celld/blob/v0.6.3-widefleet.1/docs/services/r2.md), [D1](https://github.com/widefleet/celld/blob/v0.6.3-widefleet.1/docs/services/d1.md), [Cloudflare Dynamic Worker limits](https://developers.cloudflare.com/dynamic-workers/platform/limits/), [Cloudflare RPC](https://developers.cloudflare.com/workers/runtime-apis/rpc/), [Cloudflare Egress](https://developers.cloudflare.com/dynamic-workers/usage/egress-control/), [Dynamic Worker observability](https://developers.cloudflare.com/dynamic-workers/usage/observability/), [Cloudflare KV](https://developers.cloudflare.com/kv/concepts/how-kv-works/), [Cloudflare D1](https://developers.cloudflare.com/d1/worker-api/d1-database/#dump).

## How Widefleet integrates the runtime

- App logs and errors from HTTP requests go to ingestion scoped to each app. See
  [runtime logs](/self-hosting/runtime-logs) for capture coverage and delivery.
- Each installation runs on one managed node.
- Workflows run through a platform adapter; automatic facets are excluded.
- App service calls transfer values; use `fetch()` for HTTP bodies. Callbacks,
  returned RPC objects and custom-RPC streams are outside the common contract.
  Dynamic apps cannot declare Durable Object classes. Service RPC logs do not
  appear in app logs.
- [App removal](/reference/runtime#app-removal) clears deletable files and active
  references; D1, KV and Queue storage and shared deployment history can remain.

## Node.js compatibility

Enable `"compatibility_flags": ["nodejs_compat"]` to select Widefleet's Node-aware
bundling. Builtins such as `node:buffer`, `node:crypto` and bare imports such as
`path` remain for celld to resolve. npm dependencies are bundled locally with Worker
export conditions; bundled CommonJS dependencies can require runtime builtins.
To enable it for an existing app, add the flag and redeploy.

Supported APIs are listed in the [pinned celld Node API reference](https://github.com/widefleet/celld/blob/v0.6.3-widefleet.1/docs/cloudflare-compat.md#nodejs-compatibility).
Use Web Crypto for encryption; Node crypto ciphers and child processes are not
available, and `fs` uses celld's virtual filesystem. The `nodejs_compat` flag
configures Widefleet's bundling; celld exposes its implemented Node APIs
independently. The agent deploys the code bundled locally.

## Browser isolation

Each app runs at its own origin, not inside an iframe. Its content security policy
allows the app's own origin plus the `browser` origins it declares, for connections
and for scripts, styles, images and fonts; inline scripts and styles are allowed,
and images and fonts may also use `data:` (images also `blob:`). This list is
separate from backend grants, and the runtime applies it to every app response.
See [network permissions and limits](/guides/network).

For comparison, Cloudflare OS gadgets run as `srcDoc` in a sandboxed iframe with
`connect-src 'none'` and reach their backend through Cap'n Web RPC over
`postMessage` (observed at commit `9c2b76a`).

Sources: [gadget CSP](https://github.com/cloudflare/cloudflare-os/blob/9c2b76a067e9b34013de78f82a2dc9c4c627d763/packages/workshop-frontend/src/GadgetUI.tsx#L105),
[iframe](https://github.com/cloudflare/cloudflare-os/blob/9c2b76a067e9b34013de78f82a2dc9c4c627d763/packages/workshop-frontend/src/GadgetUI.tsx#L507),
[sandbox model](https://github.com/cloudflare/cloudflare-os/blob/9c2b76a067e9b34013de78f82a2dc9c4c627d763/README.md#security).
