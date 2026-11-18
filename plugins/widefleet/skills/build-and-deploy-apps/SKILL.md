---
name: build-and-deploy-apps
description: Create, change, preview and deploy Widefleet apps using the Widefleet CLI in your shell. Use when the user wants to build an app or internal tool, deploy or publish an app, update or roll back an existing Widefleet app, or continue work on an app from an earlier session.
---

# Build and deploy Widefleet apps

Widefleet apps are built and deployed with the Widefleet CLI. The Widefleet MCP tools
(`search`, `describe`, `call`, `execute`) only use apps that are already running; they
cannot create or deploy apps. Do this work in your shell.

If you have no shell, say so and stop. Do not claim that deployment is unavailable
when a shell is available.

The documentation is the source of truth. Read the relevant page as Markdown before
relying on memory, starting with https://widefleet.com/docs/llms.txt. Useful pages:

- App development: https://widefleet.com/docs/guides/app-development.md
- Deployments: https://widefleet.com/docs/guides/deployments.md
- Source code: https://widefleet.com/docs/guides/source-code.md
- CLI reference: https://widefleet.com/docs/reference/cli.md

## 1. Prepare the shell

```sh
node --version
npm install --global pnpm widefleet
widefleet --version
```

Apps need Node.js 22.18 or newer. If Node.js is older, upgrade it before building.

Your shell may not keep environment variables between commands. Pass options such as
`--organization` explicitly on every command instead of relying on `export`.

## 2. Sign in

Check for an existing session first:

```sh
widefleet whoami
```

If you are not signed in, start the login in the background so that you can read its
link while it waits for approval:

```sh
nohup widefleet login > ~/widefleet-login.log 2>&1 &
sleep 5
cat ~/widefleet-login.log
```

Give the user the link and device code from the log and ask them to open the link, sign
in and approve the code in their own browser. When they confirm, run `widefleet whoami`.
If the login expired, start it again. Never print or share session files or tokens.

Then select the organization:

```sh
widefleet organizations
```

If there is more than one, ask the user which to use. Pass `--organization ID` to every
following command.

## 3. Start from the right place

Check what already exists before creating anything:

```sh
widefleet apps --organization ID
widefleet catalog templates list --organization ID
```

- **Continue an existing app:** run `widefleet source clone APP_UUID my-app --organization ID`.
  Your shell is temporary, so always start from the saved source instead of rewriting an app.
- **Use a template:** run `widefleet catalog templates show TEMPLATE_ID --organization ID`
  and follow its instructions.
- **Create a new app:** ask what the app should do, then run `widefleet init my-app`.
  The directory name becomes the app name in `wrangler.jsonc`; use a short, lowercase
  name that describes the app. Add `--template tanstack-start` only if the user wants React.

Then install dependencies:

```sh
cd my-app
pnpm install --frozen-lockfile
```

## 4. Build and check

Follow the app development guide for identity, databases, file storage and calling
other apps. Before every deployment, run:

```sh
pnpm check
pnpm build
```

Fix every reported error before deploying.

## 5. Deploy

**New app:** the first deployment creates it. Tell the user the app name and that it
will be published to their organization, ask for confirmation, then run:

```sh
widefleet deploy --json --organization ID
```

**Change to an existing app:** publish a preview first. Previews have their own empty
data and do not affect the running app.

```sh
git switch -c change-name
widefleet preview --organization ID
```

Share the preview URL and let the user check it. When they approve, publish:

```sh
git switch main
git merge change-name
widefleet deploy --json --organization ID
```

Deploying saves the code to the app's Git repository, so the work can continue in a
later session. Never use `--no-source` or `--allow-branch-mismatch` unless the user
asks for it.

After a successful deployment, give the user the app URL from the result. To control
who can open the app, follow https://widefleet.com/docs/guides/applications.md.

## 6. When something fails

```sh
widefleet history APP_UUID --organization ID
widefleet events APP_UUID DEPLOYMENT_UUID --organization ID
widefleet logs APP_UUID --level error --since 1h --organization ID
```

A failed update keeps the previously running version. Explain the cause to the user,
fix it and deploy again. Roll back only with the user's agreement:
`widefleet rollback APP_UUID ARTIFACT_UUID --organization ID`.

Ask the user before deleting an app or preview, changing access rules, network
permissions, secrets or app connections, or applying database migrations.
