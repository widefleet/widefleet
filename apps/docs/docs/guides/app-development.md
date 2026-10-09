---
title: App development
description: Develop an independent SvelteKit app with identity, storage and platform integrations.
---

The generated SvelteKit starter is an independent project with no workspace dependencies. Start it with `pnpm dev`; local development uses a synthetic identity. Production requests use the verified SSO identity exposed as `locals.user`. App SSO strips request cookies and response `Set-Cookie` headers, so apps cannot use their own server-side cookie sessions.

Declare resources in `wrangler.jsonc`; deploys preserve resource IDs and names inside the app's fleet. Migration commands require CLI and platform 0.3.0 or newer, with matching CLI, management and agent versions. Use `widefleet migrations list DB` and `widefleet migrations apply DB` for explicit app-schema migrations. See [D1 migrations](/guides/migrations) for SQL files and Drizzle configuration. Code rollback does not restore older database or file contents.

New starters enable `"compatibility_flags": ["nodejs_compat"]`. Existing apps must set the flag explicitly and redeploy with CLI 0.1.3 or newer and a compatible management server. This exposes celld's partial Node API surface; see the [Node.js compatibility](/reference/runtime-compatibility#nodejs-compatibility) for supported imports and runtime limits.

Run `widefleet preview` from the app project to build and deploy an isolated preview named after the current Git branch. Use `widefleet preview --name review` for a stable named preview. The CLI accepts the same `--config`, `--skip-build`, `--no-wait` and `--json` flags as `deploy`; `--app NAME_OR_UUID` selects another parent. See [previews](/reference/previews) for naming, TLS setup and isolated resources.

The existing `widefleet create notes-preview --name 'Notes Preview' --parent APP_UUID` workflow keeps its flat hostname; deploy to the returned ID explicitly. Use `widefleet rollback APP_UUID ARTIFACT_UUID` to restore retained code and `widefleet delete APP_UUID --yes` to remove an app and its published versions. See [app removal](/reference/runtime#app-removal) for the cleanup process and remaining native storage cells.

External requests need [network permissions](/guides/network). For IT-managed system access, use [connectors](/guides/connectors). Apps can also declare [Workflows](/guides/workflows) with a compatible deployment agent and runtime.
