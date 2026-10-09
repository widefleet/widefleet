---
title: Installation
description: Set up the Widefleet CLI and create an app for an existing installation.
---

Use the Widefleet CLI to create and deploy apps from your own machine. You need
access to a Widefleet installation; if you do not have one yet, start with the
[local quickstart](/getting-started/quickstart).

## Install the CLI

The CLI supports Linux x64 with glibc, macOS on Apple Silicon and Intel,
and Windows x64.
Windows ARM64 and Linux musl are not release targets.

Install Node.js 26 and pnpm 12.4.2
for app development. The public npm package does not require a GitHub account
or registry token. Use a CLI version compatible with your installation.

```sh
pnpm add --global widefleet --registry=https://registry.npmjs.org
widefleet --version
```

This installs the latest release. To install a specific version, use
`widefleet@VERSION` in the command above.

pnpm downloads the native package for your operating system and CPU. Keep optional
dependencies enabled; installation works with scripts disabled and the CLI does
not download binaries when it starts.

The installation commands work in Fish too. If pnpm reports that its global bin directory is missing from PATH, run `pnpm setup`, open a new terminal, and retry the installation. This configures pnpm's global command directory for your shell. If you previously installed an archive manually, remove only its old `~/.local/bin/widefleet` symlink so that it cannot shadow the pnpm-managed command; use `type -a widefleet` to inspect command resolution.

To update later, rerun the install command with the desired published version. To uninstall, run `pnpm remove --global widefleet`. pnpm owns the complete installation directory; keep its package contents together.

App access groups, the catalog, D1 migration commands and Workflows require
CLI and platform `0.3.0` or newer. Update matching platform components together;
see the [CLI version notes](/reference/cli).

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

Set your installation's management URL. The following commands use Bash:

```sh
export PLATFORM_URL=https://platform.example.com
widefleet login
pnpm check
widefleet deploy
```

In Fish, use `set -gx PLATFORM_URL https://platform.example.com` instead of `export`.
In PowerShell, use `$env:PLATFORM_URL = "https://platform.example.com"`.

Approve the device code in your browser. The CLI stores credentials in your
operating system's credential store: Keychain on macOS, Credential Manager on
Windows, and Secret Service on Linux. The store must be available and unlocked.

For the local demo, use `http://localhost:25450` as `PLATFORM_URL` and approve the
code with `admin@example.test`.

The target app is identified by your installation and the `name` in
`wrangler.jsonc`. The first deploy creates it when needed; later deploys update
the same app. After successful activation, the CLI prints `Deployment succeeded`
and the app URL. Open it, sign in with your company account, and add a note and
photo to verify the deployed app's database and file storage.

For ongoing development, follow [app development](/guides/app-development).

## Headless login

On Linux and macOS without an available credential store, CLI 0.2.1 or newer supports an
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
| Registry returns 404                     | Check the package name and published version on [npm](https://www.npmjs.com/package/widefleet); use the matching release archive if needed.                     |
| `widefleet` is not found                 | Reopen the terminal after `pnpm setup`; check `Get-Command widefleet -All` in PowerShell or `type -a widefleet` in Bash/Fish for an older installation on PATH. |
| Login cannot access the credential store | Check your operating system's credential store; see [headless login](#headless-login) for alternatives.                                                         |
| Deployment fails or stays queued         | Follow [deployment diagnostics](/guides/deployments#inspect-a-failure).                                                                                         |

Next, [share the app with colleagues](/guides/applications) or
[publish an isolated preview](/guides/deployments). The [CLI reference](/reference/cli)
lists common commands and output behavior.

## Install a release archive manually

Download the matching CLI `.tar.gz` archive and `.sha256` file from [GitHub Releases](https://github.com/widefleet/widefleet/releases). The archive suffix identifies the platform:

| Platform             | Archive suffix |
| -------------------- | -------------- |
| Linux x64, glibc     | `linux-x64`    |
| macOS, Apple Silicon | `darwin-arm64` |
| macOS, Intel         | `darwin-x64`   |
| Windows x64          | `win32-x64`    |

Verify and extract the archive in a directory you own. In the Linux example below,
replace `VERSION` with the downloaded release's version:

```sh
sha256sum --check widefleet-cli-VERSION-linux-x64.tar.gz.sha256
mkdir -p "$HOME/.local/lib/widefleet" "$HOME/.local/bin"
tar -xzf widefleet-cli-VERSION-linux-x64.tar.gz -C "$HOME/.local/lib/widefleet"
ln -s "$HOME/.local/lib/widefleet/widefleet-cli-VERSION-linux-x64/widefleet" "$HOME/.local/bin/widefleet"
export PATH="$HOME/.local/bin:$PATH"
widefleet --version
widefleet init my-app
cd my-app
pnpm install --frozen-lockfile
pnpm check
```

Keep the complete extracted release directory: `widefleet` finds `esbuild`, `release.json` and `starter` beside its resolved executable, including when invoked through a symlink. Copying only the Rust executable is not a complete installation. To upgrade, extract the new release in its own directory and update your symlink; existing app projects remain unchanged.

On macOS, use the matching archive suffix and verify with `shasum -a 256 --check ARCHIVE.tar.gz.sha256` instead of `sha256sum`.

On Windows, use the `win32-x64` archive and run these commands in PowerShell,
replacing `VERSION` with the downloaded release's version:

```powershell
$archive = "widefleet-cli-VERSION-win32-x64.tar.gz"
$expected = (Get-Content "$archive.sha256").Split(" ")[0]
if ((Get-FileHash $archive -Algorithm SHA256).Hash -ne $expected) { throw "Checksum mismatch" }
$directory = "$env:LOCALAPPDATA\widefleet"
New-Item -ItemType Directory -Force $directory | Out-Null
tar -xzf $archive -C $directory
$env:PATH = "$directory\widefleet-cli-VERSION-win32-x64;$env:PATH"
widefleet --version
```

Add that extracted directory to your user PATH through Windows Environment Variables
to keep it available in new terminals. Keep `widefleet.exe`, `esbuild.exe`,
`release.json` and `starter` together.

In environments without `/proc/self/exe`, the CLI resolves its invocation path, searching `PATH` when invoked by command name and following symlinks to the installation directory. Wrappers must preserve a resolvable executable path or command name in `argv[0]`. Deployment validates the installation metadata and bundled esbuild before starting the app build. These checks also run with `--skip-build`.

Follow the generated project's README for login, app creation and deployment. Set `PLATFORM_URL` to your installation's management origin. For the local demo that is `http://localhost:25450`; choose `admin@example.test` when approving device login. Select additional API scopes with `widefleet login --scope platform:read platform:write network:manage`; commands share one saved session. See [network permissions](/guides/network) for project-based grant management. The default credential store on Linux requires an available, unlocked Secret Service and a session D-Bus. The demo's `./dev cli` wrapper is a separate Docker convenience and does not exercise native credential storage.

`widefleet init` works offline and needs no account. Installing the generated project's dependencies requires access to the npm registry. The project has its own lockfile, strict TypeScript configuration, type-aware lint rules and formatter. Its identity helper is normal app source; later helper changes must be applied to existing apps deliberately.
