---
title: Runtime compatibility
description: Supported runtime integrations and verified differences from Cloudflare.
lastModified: 2026-10-12
---

Widefleet currently uses celld **0.6.2**. Dynamic Worker and deployment tests exercise the new
version, including outbound requests, resources, activation and restarts. Additional
regressions cover `self` in loaded Workers and incoming request cancellation.
See the [native release notes](https://github.com/denoland/celld/releases/tag/v0.6.2)
and [upgrade instructions](/self-hosting/installation#upgrade-deliberately).

This reference compares Widefleet with Cloudflare's hosted platform, its local
`workerd` runtime and Cloudflare OS.

## Native runtime differences

| Area                           | celld 0.6.1 observation                                                                                                                            | Comparison and effect on Widefleet                                                                                                                                                                                                                                               |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dynamic Worker capacity        | At most 256 loaded instances per process, including copies and old generations; at most 255 from one script generation.                            | Cloudflare limits simultaneously active distinct Dynamic Workers per I/O context: four per Worker request and ten per Durable Object. celld counts loaded instances across the process; collection and concurrent load determine how many registered apps fit within that limit. |
| Streams over RPC               | Streams cannot cross isolates through custom RPC; a local Dynamic Worker to service-binding call fails cloning.                                    | Cloudflare RPC supports byte-oriented readable/writable streams with flow control. Widefleet uses native Fetcher service bindings for individual KV and R2 values while preserving the public app API.                                                                           |
| Streams over service `fetch()` | Host-backed HTTP bodies can be forwarded. JavaScript-created streams are fully buffered when crossing isolates.                                    | Cloudflare supports streaming request/response bodies. In Widefleet, `KV.put(key, request.body)` avoids an extra full adapter buffer for host-backed bodies.                                                                                                                     |
| Forwarded RPC stubs            | An RPC stub cannot cross an isolate boundary; a loaded Worker entrypoint cannot be passed to another Worker.                                       | Cloudflare supports forwarding received stubs. Widefleet supports direct calls through granted service bindings.                                                                                                                                                                 |
| Dynamic Worker tails           | Tails cover `fetch`, not RPC, with at most 256 KiB of serialized console logs per call.                                                            | A local test with `workerd` 1.20261001.1 confirmed HTTP and RPC tails. Widefleet's Cron/Queue calls are delivered over RPC and therefore do not appear in app tails.                                                                                                             |
| Controlled outbound traffic    | A `globalOutbound` Fetcher cannot proxy TCP `connect()` or outgoing WebSockets; these calls fail.                                                  | Cloudflare documents proxying `fetch()` and `connect()`. Widefleet brokers HTTP requests through its network gateway.                                                                                                                                                            |
| KV storage                     | A namespace is a cell with one owner. No edge cache; `cacheTtl` has no effect and `cacheStatus` is `null`. Native processing still buffers values. | Cloudflare KV uses geographically distributed caches with different consistency and latency.                                                                                                                                                                                     |
| R2                             | No `ssecKey` or `jurisdiction`; conditional writes from streams larger than 8 MiB are unsupported.                                                 | Widefleet forwards supported R2 operations through app-scoped bindings; see the [runtime reference](/reference/runtime#compatibility-and-current-limits).                                                                                                                        |
| D1 export                      | `dump()` throws.                                                                                                                                   | Cloudflare also restricts `dump()` to databases from its D1 alpha period.                                                                                                                                                                                                        |

Sources: [celld Dynamic Workers](https://github.com/denoland/celld/blob/v0.6.1/docs/services/dynamic-workers.md), [celld RPC und Streams](https://github.com/denoland/celld/blob/v0.6.1/docs/cloudflare-compat.md#rpc), [native Stream-Übertragung](https://github.com/denoland/celld/blob/v0.6.1/crates/celld/js/harness.js#L3580), [KV](https://github.com/denoland/celld/blob/v0.6.1/docs/services/kv.md), [R2](https://github.com/denoland/celld/blob/v0.6.1/docs/services/r2.md), [D1](https://github.com/denoland/celld/blob/v0.6.1/docs/services/d1.md), [Cloudflare Dynamic-Worker-Limits](https://developers.cloudflare.com/dynamic-workers/platform/limits/), [Cloudflare RPC](https://developers.cloudflare.com/workers/runtime-apis/rpc/), [Cloudflare Egress](https://developers.cloudflare.com/dynamic-workers/usage/egress-control/), [Dynamic-Worker-Observability](https://developers.cloudflare.com/dynamic-workers/usage/observability/), [Cloudflare KV](https://developers.cloudflare.com/kv/concepts/how-kv-works/), [Cloudflare D1](https://developers.cloudflare.com/d1/worker-api/d1-database/#dump).

## Widefleet implementation limits

Widefleet integrates the native runtime as follows:

- App tails export HTTP logs and errors through ingestion scoped to each app.
  Native fleet OTLP export is disabled. See [runtime logs](/self-hosting/runtime-logs)
  for capture coverage and delivery behavior.
- Provisioning manages one node per fleet. celld itself supports multiple nodes.
- [Workflows](/guides/workflows) use the usual `WorkflowEntrypoint` and step APIs
  through a platform adapter on unchanged celld. Automatic facets are excluded.
  [Connectors](/guides/connectors) run as regular Workers and may declare their own
  Durable Objects. Class names must be unique within the fleet; a default Worker
  export is required even with named RPC entrypoints.
- App removal clears deletable files and active references. Native D1/KV/Queue cells and shared deployment
  history may remain. See [app removal](/reference/runtime#app-removal).
- Widefleet adds no blanket CPU/RAM, request, Worker-cache or origin-count caps.
  Native runtime and transport limits still apply.

## Node.js compatibility

Enable `"compatibility_flags": ["nodejs_compat"]` to select Widefleet's Node-aware
bundling. Builtins such as `node:buffer`, `node:crypto` and bare imports such as
`path` remain for celld to resolve. npm dependencies are bundled locally with Worker
export conditions; bundled CommonJS dependencies can require runtime builtins.
Existing apps must opt in and redeploy with CLI 0.1.3 or newer and a compatible
management server.

Supported APIs are listed in the [celld 0.6.1 Node API reference](https://github.com/denoland/celld/blob/v0.6.1/docs/cloudflare-compat.md#nodejs-compatibility).
Crypto ciphers and child processes are unavailable, and `fs` uses celld's virtual
filesystem. The `nodejs_compat` flag configures Widefleet's bundling; celld exposes
its implemented Node APIs independently. The agent deploys the code bundled locally.

## Browser isolation comparison

The following observations refer to the Cloudflare OS gadget interface at commit
`9c2b76a067e9b34013de78f82a2dc9c4c627d763`.

| Area                | Cloudflare OS gadget                                                                      | Widefleet                                           |
| ------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Embedding           | `srcDoc` in an iframe without `allow-same-origin`                                         | Separate app URL without an iframe                  |
| Browser connections | `connect-src 'none'`; backend calls use Cap'n Web RPC through `postMessage` to the parent | Own origin and explicit `browser` origins           |
| Images              | `data:` only                                                                              | Own origin, `data:`, `blob:` and `browser` origins  |
| Fonts               | No dedicated grant; `default-src 'none'` applies                                          | Own origin, `data:` and `browser` origins           |
| JavaScript/CSS      | Embedded or `data:`; inline code allowed                                                  | Own origin, inline code and granted browser origins |

The Cloudflare OS iframe allows popups to leave its sandbox.
Widefleet uses one browser-origin list for connections and resources, separate from
backend grants. The trusted loader enforces this policy on app responses.
See [network permissions and limits](/guides/network).

Sources: [gadget CSP](https://github.com/cloudflare/cloudflare-os/blob/9c2b76a067e9b34013de78f82a2dc9c4c627d763/packages/workshop-frontend/src/GadgetUI.tsx#L105),
[iframe](https://github.com/cloudflare/cloudflare-os/blob/9c2b76a067e9b34013de78f82a2dc9c4c627d763/packages/workshop-frontend/src/GadgetUI.tsx#L507),
[sandbox model](https://github.com/cloudflare/cloudflare-os/blob/9c2b76a067e9b34013de78f82a2dc9c4c627d763/README.md#security).
