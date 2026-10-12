# TanStack Start app on Widefleet

This independent React app uses TanStack Start, D1 notes and private R2 photos.
You need Node.js 22.18 or newer, an existing pnpm 10.34.5 or newer installation,
and the Widefleet CLI release that generated this project. With pnpm's default
version management, the project automatically downloads and uses its pinned pnpm
12.4.2. Docker and the Widefleet source repository are not required.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm dev
```

Open the local URL printed by the development server. The page shows a synthetic
identity; create a note with a photo to verify local storage. JavaScript is
required to submit the example form.

## Build and deploy

Stop the development server and connect to your company's installation:

```sh
widefleet login
pnpm check
widefleet deploy
```

The CLI builds the app and deploys the Worker declared in `wrangler.jsonc`. Review
its `name` and the platform selected by `widefleet config show` before deploying.
After activation, open the printed app URL and sign in with your company account.
See [CLI installation](https://widefleet.com/docs/getting-started/installation)
for setup and login recovery.

## App development

Edit `src/routes` and use `context.user` in server functions and server routes
for the verified company identity. Preserve authentication in `src/server.ts`
and CSRF protection in `src/start.ts`. Deployed apps cannot use separate cookie
sessions.

Declare resources in `wrangler.jsonc`. Run `pnpm types` after adding routes or
changing bindings; `.platform` contains generated files. Use `pnpm build` when
building manually: it generates a single version for browser and server error
reports. Direct `vite build` exits with a message to use the build script.

The example uses `DB` and `FILES`; keep those declarations while using its notes
and photos. Database and file contents survive code deployments and rollback.
Use [explicit migrations](https://widefleet.com/docs/guides/migrations) when
changing an existing schema.

The starter captures unexpected server and browser errors. For caught technical
failures, use `captureError` from `src/lib/server/capture-error.ts` on the server
or `src/lib/capture-error.ts` in browser code. Keep source maps private and
preserve the browser's embedded build version.

```sh
widefleet logs --level error --since 1h --json
```

Runtime logs require the operator's telemetry services. If the command fails,
report that failure rather than assuming there are no errors.

Next, [publish an isolated preview](https://widefleet.com/docs/guides/deployments)
or follow [app development](https://widefleet.com/docs/guides/app-development)
for resources, network permissions and IT connectors.
