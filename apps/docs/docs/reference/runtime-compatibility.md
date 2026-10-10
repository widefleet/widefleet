---
title: Runtime compatibility
description: Verified native runtime differences and Widefleet implementation limits.
---

Widefleet currently uses celld **0.6.2**. Dynamic Worker and deployment tests exercise the new
version, including outbound requests, resources, activation and restarts. Additional
regressions cover `self` in loaded Workers and incoming request cancellation.
See the [native release notes](https://github.com/denoland/celld/releases/tag/v0.6.2)
and [upgrade instructions](/self-hosting/installation#upgrade-deliberately).

This is a record of verified differences, not a complete Cloudflare compatibility
claim. Cloudflare's hosted platform, its local `workerd` runtime and Cloudflare OS
are separate comparisons.

## Native runtime differences

| Area                           | celld 0.6.1 observation                                                                                                                            | Comparison and effect on Widefleet                                                                                                                                                                                                                                                                            |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dynamic Worker capacity        | At most 256 loaded instances per process, including copies and old generations; at most 255 from one script generation.                            | Cloudflare limits simultaneously active distinct Dynamic Workers per I/O context: four per Worker request and ten per Durable Object. These count different things. A 257th registered app does not automatically require another fleet; collection, concurrent load and additional nodes determine capacity. |
| Streams over RPC               | Streams cannot cross isolates through custom RPC; a local Dynamic Worker to service-binding call fails cloning.                                    | Cloudflare RPC supports byte-oriented readable/writable streams with flow control. Widefleet uses native Fetcher service bindings for individual KV and R2 values while preserving the public app API.                                                                                                        |
| Streams over service `fetch()` | Host-backed HTTP bodies can be forwarded. JavaScript-created streams are fully buffered when crossing isolates.                                    | Cloudflare supports streaming request/response bodies; that does not establish identical internals. `KV.put(key, request.body)` avoids an extra full adapter buffer, but a JavaScript-created stream is not automatically transferred without buffering.                                                      |
| Forwarded RPC stubs            | An RPC stub cannot cross an isolate boundary; a loaded Worker entrypoint cannot be passed to another Worker.                                       | Cloudflare allows forwarding received stubs. Direct calls through loader-granted service bindings work; connectors must not assume arbitrary Cloudflare RPC object graphs are supported.                                                                                                                      |
| Dynamic Worker tails           | Tails cover `fetch`, not RPC, with at most 256 KiB of serialized console logs per call.                                                            | A local test with `workerd` 1.20261001.1 confirmed HTTP and RPC tails. Widefleet's Cron/Queue calls are delivered over RPC and therefore do not appear in app tails.                                                                                                                                          |
| Controlled outbound traffic    | A `globalOutbound` Fetcher cannot proxy TCP `connect()` or outgoing WebSockets; these calls fail.                                                  | Cloudflare documents proxying `fetch()` and `connect()`. An allowed HTTPS origin in Widefleet does not grant arbitrary socket access.                                                                                                                                                                         |
| KV storage                     | A namespace is a cell with one owner. No edge cache; `cacheTtl` has no effect and `cacheStatus` is `null`. Native processing still buffers values. | Cloudflare KV uses geographically distributed caches with different consistency and latency. Matching methods do not imply matching distribution or cache semantics.                                                                                                                                          |
| R2                             | No `ssecKey` or `jurisdiction`; conditional writes from streams larger than 8 MiB are unsupported.                                                 | Cloudflare types alone do not establish support in celld or Widefleet's adapter.                                                                                                                                                                                                                              |
| D1 export                      | `dump()` throws.                                                                                                                                   | Cloudflare also restricts `dump()` to databases from its D1 alpha period. The method is outside Widefleet's supported app contract.                                                                                                                                                                           |

Sources: [celld Dynamic Workers](https://github.com/denoland/celld/blob/v0.6.1/docs/services/dynamic-workers.md), [celld RPC und Streams](https://github.com/denoland/celld/blob/v0.6.1/docs/cloudflare-compat.md#rpc), [native Stream-Übertragung](https://github.com/denoland/celld/blob/v0.6.1/crates/celld/js/harness.js#L3580), [KV](https://github.com/denoland/celld/blob/v0.6.1/docs/services/kv.md), [R2](https://github.com/denoland/celld/blob/v0.6.1/docs/services/r2.md), [D1](https://github.com/denoland/celld/blob/v0.6.1/docs/services/d1.md), [Cloudflare Dynamic-Worker-Limits](https://developers.cloudflare.com/dynamic-workers/platform/limits/), [Cloudflare RPC](https://developers.cloudflare.com/workers/runtime-apis/rpc/), [Cloudflare Egress](https://developers.cloudflare.com/dynamic-workers/usage/egress-control/), [Dynamic-Worker-Observability](https://developers.cloudflare.com/dynamic-workers/usage/observability/), [Cloudflare KV](https://developers.cloudflare.com/kv/concepts/how-kv-works/), [Cloudflare D1](https://developers.cloudflare.com/d1/worker-api/d1-database/#dump).

## Widefleet implementation limits

These are platform choices or integration limits, not claims that celld lacks the
underlying capabilities:

- Native fleet telemetry is disabled. celld can export native logs and traces, but
  Widefleet's ingestion authenticates and partitions by app. Shared fleet records
  cannot safely be assigned to an app token. App tails export HTTP logs and errors
  without a durable outgoing queue or retry. Complete tracing parity for Dynamic
  Workers is unverified. See [runtime logs](/self-hosting/runtime-logs) and
  [Cloudflare traces](https://developers.cloudflare.com/workers/observability/traces/).
- Provisioning manages one node per fleet. celld itself supports multiple nodes.
- [Workflows](/guides/workflows) use the usual `WorkflowEntrypoint` and step APIs
  through a platform adapter on unchanged celld. Automatic facets are excluded.
  [Connectors](/guides/connectors) run as regular Workers and may declare their own
  Durable Objects. Class names must be unique within the fleet; a default Worker
  export is required even with named RPC entrypoints. Native features are not
  automatically available through the dynamic app contract.
- Physical purging of native app cells remains unresolved. Deletable app files and
  active references are removed, while native D1/KV/Queue cells and shared deployment
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

The [documented celld 0.6.1 Node API surface](https://github.com/denoland/celld/blob/v0.6.1/docs/cloudflare-compat.md#nodejs-compatibility)
is partial: crypto ciphers and child processes are unavailable, and `fs` uses celld's
virtual filesystem. Successful bundling does not prove that every dependency API
works. celld exposes its implemented Node APIs independently of the flag; Widefleet
uses it for bundling. A compatibility date alone does not enable this behavior.
The agent deploys prebundled code and does not run package build scripts.

## Browser isolation comparison

The following observations refer to the Cloudflare OS gadget interface at commit
`9c2b76a067e9b34013de78f82a2dc9c4c627d763`. Administrative interfaces can have different policies.

| Area                | Cloudflare OS gadget                                                                      | Widefleet                                           |
| ------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Embedding           | `srcDoc` in an iframe without `allow-same-origin`                                         | Separate app URL without an iframe                  |
| Browser connections | `connect-src 'none'`; backend calls use Cap'n Web RPC through `postMessage` to the parent | Own origin and explicit `browser` origins           |
| Images              | `data:` only                                                                              | Own origin, `data:`, `blob:` and `browser` origins  |
| Fonts               | No dedicated grant; `default-src 'none'` applies                                          | Own origin, `data:` and `browser` origins           |
| JavaScript/CSS      | Embedded or `data:`; inline code allowed                                                  | Own origin, inline code and granted browser origins |

Cloudflare OS does not provide three configurable origin lists as a template here.
Its CSP belongs to its iframe/RPC model; the iframe explicitly allows popups and
escape from its sandbox, so this is not a guarantee that every navigation is blocked.
Widefleet uses one browser-origin list for connections and resources, separate from
backend grants. The trusted loader applies this simpler policy without an iframe.
See [network permissions and limits](/guides/network).

Sources: [gadget CSP](https://github.com/cloudflare/cloudflare-os/blob/9c2b76a067e9b34013de78f82a2dc9c4c627d763/packages/workshop-frontend/src/GadgetUI.tsx#L105),
[iframe](https://github.com/cloudflare/cloudflare-os/blob/9c2b76a067e9b34013de78f82a2dc9c4c627d763/packages/workshop-frontend/src/GadgetUI.tsx#L507),
[sandbox model](https://github.com/cloudflare/cloudflare-os/blob/9c2b76a067e9b34013de78f82a2dc9c4c627d763/README.md#security).
