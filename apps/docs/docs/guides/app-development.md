---
title: App development
description: Develop an independent app with identity, storage and platform integrations.
lastModified: 2026-10-12
---

Start with an [installed CLI and a generated app](/getting-started/installation). SvelteKit is the default; the [CLI template option](/reference/cli#create-a-project) also supports TanStack Start for React. Both starters are independent projects with no workspace dependencies and include D1 notes, private R2 photos and platform error reporting.

Run `pnpm dev` for local development with a synthetic identity. Deployed requests receive the verified company identity:

| Starter        | Identity in server code                                      |
| -------------- | ------------------------------------------------------------ |
| SvelteKit      | `locals.user` in server loads, actions and handlers          |
| TanStack Start | `context.user` in server functions and server route handlers |

For example, a TanStack Start server function can return the current user:

```ts
import { createServerFn } from "@tanstack/react-start";

export const getCurrentUser = createServerFn().handler(({ context }) => context.user);
```

Preserve the generated authentication and error hooks. In TanStack Start, keep the CSRF middleware in `src/start.ts`; the verified identity comes from `src/server.ts`. App SSO strips request cookies and response `Set-Cookie` headers, so apps cannot use their own server-side cookie sessions.

Run `pnpm check` before deployment. In TanStack Start, `pnpm types` regenerates route and Worker binding types after adding routes or changing configuration. Use `pnpm build` for production builds so browser and Worker errors share the deployment's build version; do not invoke Vite's build directly. JavaScript must be enabled to submit the TanStack example's note form.

Declare resources in `wrangler.jsonc`; deploys preserve resource IDs and names inside the app's fleet. Use `widefleet migrations list DB` and `widefleet migrations apply DB` for explicit app-schema migrations. See [D1 migrations](/guides/migrations) for SQL files and Drizzle configuration. Code rollback does not restore older database or file contents.

Starters enable `"compatibility_flags": ["nodejs_compat"]`. This exposes celld's partial Node API surface; see the [Node.js compatibility](/reference/runtime-compatibility#nodejs-compatibility) for supported imports and runtime limits.

Run `widefleet preview` from the app project to build and deploy an isolated preview named after the current Git branch. Use `widefleet preview --name review` for a stable named preview. The CLI accepts the same `--config`, `--skip-build`, `--no-wait` and `--json` flags as `deploy`; `--app NAME_OR_UUID` selects another parent. See [previews](/reference/previews) for naming, TLS setup and isolated resources.

The existing `widefleet create notes-preview --name 'Notes Preview' --parent APP_UUID` workflow keeps its flat hostname; deploy to the returned ID explicitly. Use `widefleet rollback APP_UUID ARTIFACT_UUID` to restore retained code and `widefleet delete APP_UUID --yes` to remove an app and its published versions. See [app removal](/reference/runtime#app-removal) for the cleanup process and remaining native storage cells.

External requests need [network permissions](/guides/network). For IT-managed system access, use [connectors](/guides/connectors). Apps can also declare [Workflows](/guides/workflows) with a compatible deployment agent and runtime.
