---
title: Installation
description: Set up the Widefleet CLI and create an app for an existing installation.
lastModified: 2026-10-29
---

Use the Widefleet CLI to create and deploy apps from your own machine. You need
access to a Widefleet installation; if you do not have one yet, start with the
[local quickstart](/getting-started/quickstart).

## Create or join an organization

Open your installation's sign-in page and follow your invitation or company
sign-in. If **Create an account** is available, enter your name and email and
confirm the six-digit code sent to your inbox.

Choose an organization or select **Create organization** when offered. Enter a
name and a URL name using lowercase letters, numbers and hyphens; the URL name
appears in app addresses. **Publish your first app** then shows the connection
and deployment commands for your workspace. If setup asks you to retry, repeat
the action to finish preparing that organization.

Installing Widefleet yourself? Start with
[first setup](/self-hosting/installation#infrastructure-and-first-start), then
invite colleagues or configure company sign-in.

## Install the CLI

The CLI supports Linux x64 with glibc, macOS on Apple Silicon and Intel,
and Windows x64. For app development, use Node.js 22.18 or newer and an existing
pnpm 10.34.5 or newer installation.

```sh
pnpm add --global widefleet
widefleet --version
```

If pnpm reports that its global bin directory is missing from PATH, run `pnpm setup`, open a new terminal, and retry the installation. This configures pnpm's global command directory for your shell.

To update, rerun the install command. To uninstall, run `pnpm remove --global widefleet`. pnpm owns the complete installation directory; keep its package contents together.

The CLI includes its native executable, bundler and app starters. App
developers do not need Docker or a checkout of the platform repository when
connecting to an existing installation.

## Create an app

```sh
widefleet init my-app
cd my-app
pnpm install --frozen-lockfile
pnpm dev
```

This creates the default SvelteKit project. For React, see the
[TanStack Start template and release requirements](/reference/cli#create-a-project).

Both projects pin pnpm 12.4.2 in `packageManager`. With pnpm's default version
management, an existing pnpm 10.34.5 or newer installation automatically downloads
and runs that version when you run a command inside the project.
pnpm 10.34.5 includes the [version-switching fix](https://github.com/pnpm/pnpm/releases/tag/v10.34.5)
needed to start pnpm 12 on macOS and Windows.

The starter includes a notes app, a D1 database, private R2 file storage and a
server-side identity helper. Local development uses a synthetic user. Open the
local URL printed by `pnpm dev`, then stop that server with Ctrl-C before continuing.

## Connect and deploy

Connect and deploy using CLI **0.4.3 or newer** and
[browser login](/reference/cli-configuration):

```sh
widefleet login
pnpm check
widefleet deploy
```

Open the link printed by `widefleet login`, sign in and approve the device code.
Keep the command running until it confirms the connection. If a platform address
is already configured, login opens there. Otherwise, enter your email in the
browser to find your company's installation or continue in Widefleet Cloud.
The CLI remembers the selected address for future commands.

When working with an agent, ask it to start `widefleet login` and share the
browser link. Approve the login yourself, then let the agent continue. See
[agent login](/reference/authentication#agent-login).

Run `widefleet config show` to check the saved address. IT can
[configure company discovery or distribute configuration](/self-hosting/company-setup)
to help employees reach the right installation.

For the local demo, run `widefleet login --url http://localhost:25450` and approve
the code with `admin@example.test`.

The target app is identified by your installation and the `name` in
`wrangler.jsonc`. The first deploy creates it when needed; later deploys update
the same app. After successful activation, the CLI prints `Deployment succeeded`
and the app URL. Open it, sign in with your company account, and add a note and
photo to verify the deployed app's database and file storage.

For ongoing development, follow [app development](/guides/app-development).

## Headless login

The CLI stores logins in your operating system's credential store. On Linux and
macOS, CLI 0.4.3 or newer automatically uses a private credential file when that
store is unavailable and prints its location. Windows uses Credential Manager.

Credential files contain unencrypted tokens; keep them outside app projects and
shared folders. See [CLI authentication](/reference/authentication#headless-login)
to choose a file location, manage saved logins or use an external access token.

## Inspect runtime logs

```sh
widefleet logs
widefleet logs --level error
```

Runtime logs require telemetry services enabled by the operator; the local demo
includes them.

## If setup fails

| Symptom                                  | Next step                                                                                                                                                       |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Registry returns 404                     | Check the package name and published version on [npm](https://www.npmjs.com/package/widefleet).                                                                 |
| `widefleet` is not found                 | Reopen the terminal after `pnpm setup`; check `Get-Command widefleet -All` in PowerShell or `type -a widefleet` in Bash/Fish for an older installation on PATH. |
| Login cannot access the credential store | Check your operating system's credential store; see [headless login](#headless-login) for alternatives.                                                         |
| Company discovery fails                  | Check the email domain and ask IT to publish a discovery record or configure the agent; see [company setup](/self-hosting/company-setup).                       |
| Deployment fails or stays queued         | Follow [deployment diagnostics](/guides/deployments#inspect-a-failure).                                                                                         |

Next, [share the app with colleagues](/guides/applications) or
[publish an isolated preview](/guides/deployments). The [CLI reference](/reference/cli)
lists common commands and output behavior.
