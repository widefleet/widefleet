---
title: Network permissions
description: Allow external destinations and understand backend and browser enforcement.
lastModified: 2026-11-18
---

Allow an app to call external APIs from its backend code or to load resources
from external origins in the browser. Each app has its own list of allowed
origins, which starts empty. D1, R2, KV, Queues and static asset bindings work
without a network grant.

You need:

- To be the app's owner or an organization administrator.
- A CLI login with the `network:manage` scope. Reading permissions needs `platform:read`.

## Allow an origin

1. Log in with the scopes your work needs:

   ```sh
   widefleet login --scope platform:read platform:write network:manage
   ```

   Without `--scope`, login requests `platform:read platform:write`. Explicit
   scopes replace that default and can be repeated or comma-separated.

2. From the app's project directory, allow the origin:

   ```sh
   widefleet network allow https://api.example.com
   ```

   The command waits until the change is active.

3. Check the permissions:

   ```sh
   widefleet network
   ```

   ```text
   Network permissions: active
   Backend:
     https://api.example.com
   Browser:
     No external origins allowed
   ```

4. Verify with a request from the app's backend, such as a `fetch()` to
   `https://api.example.com` in a route you can open. Requests to origins that are
   not on the list return `403` with `Network destination is not permitted`.

The CLI selects the app named in the current `wrangler.jsonc`. Use `--app NAME`
for another app or `--config PATH` for another project file. To allow a browser
origin or remove one:

```sh
widefleet network allow https://assets.example.com --browser
widefleet network deny https://api.example.com
```

`allow` and `deny` accept several origins. Repeating an applied change has no
effect. `--json` returns the full state, and redirected output is JSON by default.
Automation can use the same API token through `PLATFORM_ACCESS_TOKEN`.

## Check activation

`widefleet network` shows one of these states:

| State     | Meaning                                                             |
| --------- | ------------------------------------------------------------------- |
| `saved`   | Saved before the app's first deployment; applies when it deploys.   |
| `pending` | Activation is in progress.                                          |
| `active`  | New requests use the change.                                        |
| `failed`  | Activation failed; the reason is shown. Repeat the change to retry. |

Changes wait for activation by default; `--no-wait` returns after saving. A
failed activation returns a nonzero exit status, and the app keeps its current
permissions. If another change supersedes a waiting command, the command stops and
tells you to inspect the status.

Requests already in flight finish under their previous permissions. A code
rollback keeps the current network permissions, and previews have their own lists.

## Origins

Enter exact, canonical HTTPS origins, for example `https://api.example.com` or
`https://erp.example.com:8443`. Paths, credentials, trailing slashes and
wildcards are rejected. Grant only the origins you intend the app to reach,
including any private addresses. The lists have no fixed size limit beyond HTTP and
browser header limits.

## Backend and browser access

Backend and browser lists are independent. Commands change the backend list unless
you pass `--browser`.

**Backend** permissions apply to `fetch()` from server-side code:

- Widefleet checks every request against the list, including each followed
  redirect. The host comes from the checked URL; host and proxy headers set by
  the app are removed.
- When a redirect changes the origin, `Authorization`, `Cookie` and
  `Proxy-Authorization` headers are removed.
- `redirect: "manual"` and `redirect: "error"` work as usual, and followed
  redirects use standard method rewriting. A redirect
  that preserves the body can resend a fully sent body of up to 1 MiB; larger or
  incomplete bodies fail that redirect.
- Use HTTPS requests through `fetch()`. Outbound TCP connections and WebSockets are
  rejected. See [runtime compatibility](/reference/runtime-compatibility).

**Browser** permissions set the Content Security Policy (CSP) on the app's static
and Worker responses:

- An allowed origin is permitted for connections, scripts, styles, images, fonts,
  media and forms.
- Same-origin resources, inline scripts and styles, data images and fonts, and
  blob images and media work without a grant.
- Frames, objects and Web Workers are blocked. Top-level navigation to external
  pages works.
- Reload open pages to receive a changed CSP.

A browser grant also permits executable resources from that origin. Use the backend
list when only server-side access is needed.

## API

`GET /api/v1/apps/{appId}/network` reads the permissions and activation state.
`PATCH` makes an atomic incremental change:

```json
{
  "target": "backend",
  "action": "allow",
  "origins": ["https://api.example.com"]
}
```

Use `target: "browser"` or `action: "deny"` as needed. Concurrent changes do not
replace each other's grants.
