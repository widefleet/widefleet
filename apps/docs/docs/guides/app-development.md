---
title: App development
description: Develop an independent app with identity, storage and platform integrations.
lastModified: 2026-11-16
---

Start with an [installed CLI and a generated app](/getting-started/installation). SvelteKit is the default; the [CLI template option](/reference/cli#create-a-project) also supports TanStack Start for React. Both starters are independent projects with no workspace dependencies and include D1 notes, private R2 photos and platform error reporting.

Run `pnpm dev` for local development with a synthetic identity. Deployed requests receive the verified company identity:

| Starter        | Identity in server code                                      |
| -------------- | ------------------------------------------------------------ |
| SvelteKit      | `locals.user` in server loads, actions and handlers          |
| TanStack Start | `context.user` in server functions and server route handlers |

The identity includes `picture`, the person's profile picture from their sign-in provider as a path on the app's own address, or `null` when there is none. Use it directly as an image source, for example `<img src={user.picture} alt="">`. Everyone who can open the app sees the pictures of the organization's people.

For example, a TanStack Start server function can return the current user:

```ts
import { createServerFn } from "@tanstack/react-start";

export const getCurrentUser = createServerFn().handler(({ context }) => context.user);
```

Preserve the generated authentication and error hooks. In TanStack Start, keep the CSRF middleware in `src/start.ts`; the verified identity comes from `src/server.ts`. App SSO strips request cookies and response `Set-Cookie` headers, so apps cannot use their own server-side cookie sessions.

Run `pnpm check` before deployment. In TanStack Start, `pnpm types` regenerates route and Worker binding types after adding routes or changing configuration. Use `pnpm build` for production builds so browser and Worker errors share the deployment's build version; do not invoke Vite's build directly. JavaScript must be enabled to submit the TanStack example's note form.

Declare resources in `wrangler.jsonc`; deploys preserve resource IDs and names inside the app's fleet. Use `widefleet migrations list DB` and `widefleet migrations apply DB` for explicit app-schema migrations. See [D1 migrations](/guides/migrations) for SQL files and Drizzle configuration. Code rollback does not restore older database or file contents.

Starters enable `"compatibility_flags": ["nodejs_compat"]`. This exposes celld's partial Node API surface; see the [Node.js compatibility](/reference/runtime-compatibility#nodejs-compatibility) for supported imports and runtime limits.

Create a work branch and run `widefleet preview` from the app project to build and deploy an isolated preview. With source storage, the branch determines the preview's name and saved code. When source storage is disabled or unavailable, use `widefleet preview --name review` to choose a name. The CLI accepts the same `--config`, `--skip-build`, `--no-wait` and `--json` flags as `deploy`; `--app NAME_OR_UUID` selects another parent. See [previews](/reference/previews) for naming, TLS setup and isolated resources.

Use `widefleet rollback APP_UUID ARTIFACT_UUID` to restore retained code and `widefleet delete APP_UUID --yes` to remove an app and its published versions. See [app removal](/reference/runtime#app-removal) for the cleanup process and remaining native storage cells.

External requests need [network permissions](/guides/network). For IT-managed system access, use [app services](/guides/app-services). Apps can also declare [Workflows](/guides/workflows) with a compatible deployment agent and runtime.

Use [workload identity](/guides/workload-identity) to authenticate an app or service
to an external API with a short-lived token, without storing an API key in the app.
