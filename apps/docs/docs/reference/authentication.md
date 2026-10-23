---
title: CLI authentication
description: Credential stores, headless sessions, token renewal and external credentials.
lastModified: 2026-10-23
---

Run `widefleet login`, open the printed link and approve the device code in your
browser. The CLI uses a configured address or finds your installation through
your email. See [CLI configuration](/reference/cli-configuration) for discovery
and version requirements. The default scopes are `platform:read platform:write`;
select additional scopes explicitly when needed.

With platform and CLI 0.4.0 or newer, company SSO grants the CLI access within
that organization. Widefleet email login uses the account's admitted memberships.
Sign in again after upgrading from an earlier version. See
[members and company sign-in](/guides/members) for linking and invitations.

## Agent login

Ask the agent to start `widefleet login` and keep it running in a background
terminal session. Open the link it provides, enter your email if prompted and
approve the displayed device code in your own browser. The agent can then verify
access with `widefleet whoami` and continue the task.

Keep the command running until login succeeds. If the request expires or the
command is stopped, start `widefleet login` again.

## Headless login

The CLI uses Keychain on macOS, Credential Manager on Windows and Secret Service
on Linux. Linux Secret Service needs an unlocked store and a session D-Bus.
With CLI 0.4.3 or newer, Unix systems automatically use a private, unencrypted
credential file when the OS store is unavailable. The CLI prints its location
and reuses it for later commands.

Automatic files live under `$XDG_STATE_HOME/widefleet/credentials/`, or
`~/.local/state/widefleet/credentials/` when that variable is unset.

### Choose a session file

On Unix, use `PLATFORM_SESSION_FILE` or `--session-file` to choose a location
explicitly. This option requires CLI 0.2.1 or newer. Keep the setting for later
commands, including logout:

```sh
export PLATFORM_SESSION_FILE="$HOME/.local/state/widefleet/session.json"
widefleet login --scope platform:read
widefleet whoami
widefleet apps
```

The example grants read access. Use `--scope platform:read platform:write`
when the session also needs to deploy apps. In Fish, replace `export` with
`set -gx PLATFORM_SESSION_FILE "$HOME/.local/state/widefleet/session.json"`.

Credential files contain **unencrypted access and refresh tokens**. Keep them
outside app projects and shared folders, with one file per platform address.
The CLI creates directories with mode `0700` and files with mode `0600`. Existing
paths must also be owner-only, with regular files rather than symbolic or hard
links. Use `--session-file /absolute/path/session.json` to override the environment
setting for a command. On Windows, use Credential Manager for saved logins or
an external access token for API commands.

## Token renewal and logout

Saved sessions renew automatically. Run `widefleet logout` to revoke the saved
refresh token and remove the local credentials. If logout fails, retry it while
the installation is reachable; the CLI keeps the credentials for that retry.
Use logout before removing a session file manually so server-side access is
revoked as well.

## External access tokens

Set `PLATFORM_ACCESS_TOKEN` when another system manages your credentials. It
takes precedence over saved credentials for API commands. Your system manages
renewal; `widefleet login` and `widefleet logout` manage the CLI's saved login.
In PowerShell, set the token with `$env:PLATFORM_ACCESS_TOKEN = "TOKEN"`.

For a manual device flow, include `resource=PLATFORM_URL/api/v1` in the initial
`/api/auth/device/code` request and request `offline_access` if you need a refresh
token. Token requests use `application/x-www-form-urlencoded` and an `Origin`
header matching `PLATFORM_URL`. The API resource is required for `/api/v1` access.
