---
title: Installation
description: Set up the Widefleet CLI and create an app for an existing installation.
---

Use the Widefleet CLI to create and deploy apps from your own machine. You need
access to a Widefleet installation; if you do not have one yet, start with the
[local quickstart](/getting-started/quickstart).

## Install the CLI

The CLI supports Linux x64 with glibc, macOS on Apple Silicon and Intel,
and Windows x64. Install Node.js 26 and pnpm 12.4.2 for app development.

```sh
pnpm add --global widefleet
widefleet --version
```

If pnpm reports that its global bin directory is missing from PATH, run `pnpm setup`, open a new terminal, and retry the installation. This configures pnpm's global command directory for your shell.

To update, rerun the install command. To uninstall, run `pnpm remove --global widefleet`. pnpm owns the complete installation directory; keep its package contents together.

The CLI includes its native executable, bundler and SvelteKit starter. App
developers do not need Docker or a checkout of the platform repository when
connecting to an existing installation.

## Create an app

```sh
widefleet init my-app
cd my-app
pnpm install --frozen-lockfile
pnpm dev
```

The starter includes a notes app, a D1 database, private R2 file storage and a
server-side identity helper. Local development uses a synthetic user. Open the
local URL printed by `pnpm dev`, then stop that server with Ctrl-C before continuing.

## Connect and deploy

Connect to your company and deploy:

```sh
widefleet login
pnpm check
widefleet deploy
```

If IT has configured your agent or computer, the CLI uses that platform address.
Otherwise, it asks for your work email or company domain and looks up the company's
discovery record. An agent or noninteractive terminal can supply
`widefleet login --email employee@example.com` or
`widefleet login --domain example.com`. These commands also work in PowerShell and Fish.

Approve the device code in your browser. The CLI remembers the platform URL and stores credentials in your
operating system's credential store: Keychain on macOS, Credential Manager on
Windows, and Secret Service on Linux. The store must be available and unlocked.

Run `widefleet config show` to inspect the selected URL. If discovery is not set
up, IT can [configure company discovery or distribute configuration](/self-hosting/company-setup).

For the local demo, run `widefleet login --url http://localhost:25450` and approve
the code with `admin@example.test`.

The target app is identified by your installation and the `name` in
`wrangler.jsonc`. The first deploy creates it when needed; later deploys update
the same app. After successful activation, the CLI prints `Deployment succeeded`
and the app URL. Open it, sign in with your company account, and add a note and
photo to verify the deployed app's database and file storage.

For ongoing development, follow [app development](/guides/app-development).

## Headless login

On Linux and macOS without an available credential store the CLI supports an
explicit session file. Set it before login and keep it set for subsequent commands:

```sh
export PLATFORM_SESSION_FILE="$HOME/.local/state/widefleet/session.json"
widefleet login
```

This file contains unencrypted access and refresh tokens. Keep it outside the app
project and shared folders. The CLI restricts its permissions and renews the saved
session automatically. Use `widefleet logout` with the same setting to revoke the
refresh token and remove the file. See [CLI authentication](/reference/authentication)
for exact file permissions, token scopes, renewal, logout failures and external credentials.

Session files require Unix file permissions and are unavailable on Windows. Use
Credential Manager for saved logins or `PLATFORM_ACCESS_TOKEN` for noninteractive
commands. In PowerShell, set a token with `$env:PLATFORM_ACCESS_TOKEN = "TOKEN"`.

## Inspect runtime logs

```sh
widefleet logs
widefleet logs --level error
```

Runtime logs require telemetry services enabled by the operator; the local demo
includes them. A failed log query is not evidence that the app has no errors.

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
