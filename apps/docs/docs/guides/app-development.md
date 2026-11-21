---
title: App development
description: Develop an independent app with identity, storage and platform integrations.
lastModified: 2026-11-18
---

Build, preview and ship an app on Widefleet. Start with an
[installed CLI and a generated app](/getting-started/installation). SvelteKit is the
default; the [CLI template option](/reference/cli#create-a-project) also supports
TanStack Start for React. Both starters are independent projects with no workspace
dependencies and include D1 notes, private R2 photos and platform error reporting.

## Develop locally

```sh
pnpm dev
pnpm check
```

`pnpm dev` runs the app with a synthetic signed-in user. Run `pnpm check` before
every deployment. In TanStack Start, run `pnpm types` after adding routes or
changing `wrangler.jsonc` to regenerate route and Worker binding types.

Starters enable `"compatibility_flags": ["nodejs_compat"]`, so you can import
Node.js built-in modules; see [Node.js compatibility](/reference/runtime-compatibility#nodejs-compatibility)
for supported imports.

## Use the signed-in user

Widefleet signs users in before requests reach your app. Read the verified company
identity in server code:

| Starter        | Identity in server code                                      |
| -------------- | ------------------------------------------------------------ |
| SvelteKit      | `locals.user` in server loads, actions and handlers          |
| TanStack Start | `context.user` in server functions and server route handlers |

For example, a TanStack Start server function can return the current user:

```ts
import { createServerFn } from "@tanstack/react-start";

export const getCurrentUser = createServerFn().handler(({ context }) => context.user);
```

Keep the generated authentication and error hooks. In TanStack Start, keep the CSRF
middleware in `src/start.ts`; the verified identity comes from `src/server.ts`.
Use the identity instead of a login of your own. Widefleet's sign-in cookies never
reach your app; cookies your app sets stay on the app's own host.

## Store data and files

Declare D1 databases, R2 buckets and other resources in `wrangler.jsonc`. Deploys
keep each resource's ID and name, so data persists across updates. Change the
database schema with explicit migrations:

```sh
widefleet migrations list DB
widefleet migrations apply DB
```

See [D1 migrations](/guides/migrations) for SQL files and Drizzle configuration.

## Preview a change

Create a work branch and publish an isolated preview from the app project:

```sh
git switch -c review
widefleet preview
```

With source storage, the branch names the preview and its saved code. On
installations without source storage, name the preview with
`widefleet preview --name review`. The CLI accepts the same `--config`,
`--skip-build`, `--no-wait` and `--json` flags as `deploy`; `--app NAME_OR_UUID`
selects another parent. See [previews](/reference/previews) for naming, TLS setup
and isolated resources.

## Deploy and roll back

```sh
widefleet deploy
```

`deploy` and `preview` run `pnpm build` for you. If you build yourself, use
`pnpm build` rather than Vite's build directly, so browser and Worker errors share
the deployment's build version.

To restore earlier code, run `widefleet rollback APP_UUID ARTIFACT_UUID`. Rollback
restores code only; database and file contents stay as they are. To remove an app
and its published versions, run `widefleet delete APP_UUID --yes`; see
[app removal](/reference/runtime#app-removal) for what is cleaned up.
[Deployments](/guides/deployments) covers history, failures and rollback in detail.

## Connect to other systems

- [Network permissions](/guides/network): call external APIs.
- [Connect apps](/guides/app-services): use IT-managed systems and other apps' APIs.
- [Workflows](/guides/workflows): run durable, multi-step background work.
- [Workload identity](/guides/workload-identity): authenticate to an external API
  with a short-lived token instead of a stored API key.
