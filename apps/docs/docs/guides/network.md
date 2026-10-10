---
title: Network permissions
description: Allow external destinations and understand backend and browser enforcement.
---

New apps start with no external destinations allowed. The trusted runtime checks backend requests; browser responses carry a platform-controlled Content Security Policy (CSP). D1, R2, KV, Queues and static asset bindings continue to work without granting a network origin.

## CLI

Use one ordinary login with the scopes needed by your work:

```sh
widefleet login --scope platform:read platform:write network:manage
widefleet network
widefleet network allow https://api.example.com
widefleet network deny https://api.example.com
widefleet network allow https://assets.example.com --browser
widefleet network show --app inventory
```

App selection uses `name` from the current `wrangler.jsonc`, or an explicit `--app NAME`. `--config PATH` selects another project file. These commands never create an app. There is no separate network login or credential store. Without `--scope`, login requests `platform:read platform:write`; explicit scopes replace that default and can be repeated or comma-separated. Identity and refresh scopes are added automatically. The approval page shows the requested scopes. API access still requires the signed-in user's current app permissions.

`allow` and `deny` accept multiple origins. They change only the selected entries; you do not need a policy file or revision number. Repeating an already applied change has no effect. Backend and browser permissions are independent: `--browser` changes the browser list, otherwise the backend list is selected.

Changes wait for activation by default. `--no-wait` returns after saving. `widefleet network` shows `saved` before the first deployment, `pending` during activation, `active` after acknowledgment, or `failed` with the reason. A failed activation returns a nonzero exit status; repeating the change retries it. If another change supersedes a waiting command, it stops with an explicit message. `--json` returns the full state; redirected output is JSON by default. Automation can use the same API token via `PLATFORM_ACCESS_TOKEN`.

App admins and installation administrators may change network permissions. A token additionally needs `network:manage`; reading requires `platform:read`. These scopes can coexist with deployment permissions in one token. A sufficiently authorized deployment can support combined code/configuration changes in the future; this version manages network state through the dedicated API/CLI, not `widefleet.config.ts`.

## Destinations and enforcement

Origins are exact, canonical HTTPS origins, for example `https://api.example.com` or `https://erp.example.com:8443`. Paths, credentials, trailing slashes and wildcards are rejected. Grant only the origins you intend the app to reach, including any private addresses. No fixed count limit is imposed on the lists; transport and browser header limits still apply.

The Dynamic Worker's native `globalOutbound` binding sends requests to a trusted gateway carrying that app snapshot's allowed origins. The gateway checks the URL and removes authority/proxy headers controlled by the app. Every followed redirect is checked again; credentials are removed when the origin changes. Unapproved destinations return 403. Direct socket paths cannot bypass the policy on pinned celld 0.6.2. With this outbound binding, celld 0.6.2 rejects TCP connections and outgoing WebSockets. See the [celld/Cloudflare comparison](/reference/runtime-compatibility).

Redirect handling preserves manual/error modes and standard method rewriting. A body-preserving redirect can replay a fully sent body up to 1 MiB; larger or incomplete bodies fail that redirect. This bound is for the replay copy, not the original upload, which continues through native streaming transport.

One browser list permits that origin for connections, scripts, styles, images, fonts, media and forms. This keeps grants simple; there are no independent per-resource lists. Same-origin resources and inline scripts/styles work by default, alongside data images/fonts and blob images/media. Frames, objects and Web Workers are blocked. The trusted parent replaces the CSP on both static and Worker responses, so app code and asset headers cannot weaken it.

CSP is not complete browser isolation. External top-level navigation is not prevented, and already open pages retain their previous CSP until reloaded. This version does not embed apps in sandboxed iframes. A browser grant also permits executable resources from that origin; use the backend list when only server-side access is needed.

## Activation and API

`GET /api/v1/apps/{appId}/network` reads the policy and activation state. `PATCH` makes an atomic incremental change:

```json
{
  "target": "backend",
  "action": "allow",
  "origins": ["https://api.example.com"]
}
```

Use `target: "browser"` or `action: "deny"` as appropriate. The server locks the app row while applying additions/removals, so concurrent changes do not replace unrelated grants. Revisions are maintained internally and returned for diagnostics; clients need not supply them.

A configuration job takes the serving code when it runs, after earlier fleet jobs. It creates an immutable app snapshot and validates its network revision before activation. Failed evaluation retains the serving snapshot. New requests use the selected snapshot; in-flight requests can finish under their previous permissions. Activation does not interrupt those requests. A code rollback keeps current network permissions, and previews have independent lists. Ordinary network edits do not require a celld reload.

The selected runtime must support network snapshots and return their revision during readiness checks; an older runtime is not silently accepted as having enforced the policy. Install matching management, executor and runtime components for this feature. The shared-fleet foundation requires a fresh fleet when upgrading from the earlier per-app runtime: migration `0008` rejects existing apps, selected runtimes and running jobs instead of attempting to convert earlier snapshots or leases. Published snapshots enforce their rules with the control plane and executor stopped.
