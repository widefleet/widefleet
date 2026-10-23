---
title: CLI authentication
description: Credential stores, headless sessions, token renewal and external credentials.
lastModified: 2026-10-23
---

Run `widefleet login` and open the printed link in your browser. With no configured
platform, the browser asks for your email and routes to your installation. An
existing self-hosted configuration starts device login there directly. Check the
platform and code before approving. The default scopes are
`platform:read platform:write`; select additional scopes explicitly when needed.
See [CLI configuration and availability](/reference/cli-configuration).

## Agents and interrupted login

An agent needs neither your email nor the platform URL to start:

```sh
widefleet login --no-wait --json
```

Give the user `verification_uri` and `user_code`. After they approve in their own
browser, continue in the same environment:

```sh
widefleet login --status --json
widefleet whoami
```

`--status` checks or completes the saved request once and exits. It never starts
a new request. Repeat it while authorization is pending, respecting the polling
interval enforced by the CLI. A normal `widefleet login` waits and resumes a
pending request; `--no-wait` returns after one step. A terminated process does not
discard the request. `--restart` explicitly creates a new one.

JSON reports `awaiting_selection`, `awaiting_authorization`, `finishing`,
`connected`, `denied`, `expired`, `not_started` or `not_signed_in`, with the
available browser link, code, destination, organization, expiry, credential-file
path and `next_action`. Transient operation errors report `failed` and exit
nonzero; retry the saved request. `--no-wait` and `--status` can exit successfully
while login is still pending or denied: check `status`, not only the exit code.
Waiting `--json` prints a JSON object for each changed state. The one-step flags
are simpler for agents to parse.

Only `connected` means credentials and the selected target are ready. Check the
command's exit status too: saving configuration can fail after authorization;
the error explains how to recover. A pending or approved request does not mean an
app was deployed. Continue the requested task after login succeeds.

Cloud requests expire after 30 minutes; approved codes must be collected within
nine minutes. Direct device login follows the expiry returned by its server.
Keep the same config profile and credential storage when resuming. Pending
secrets use the credential store or a private file; an explicit session file has
a private `.login` companion. An ephemeral sandbox that loses this state needs a
new login. Old links expire even after a local `--restart`.

With platform and CLI 0.4.0 or newer, a CLI approved through company SSO retains
that organization's authority through token refresh. Another organization selection
cannot expand it. A Widefleet email login can access the account's admitted memberships.
See [members and company sign-in](/guides/members) for linking and invitations.
After upgrading to 0.4.0, run `widefleet login` again: credentials
issued without a recorded authentication context are rejected.

## Headless login

Keychain on macOS, Credential Manager on Windows and Secret Service on Linux are
the preferred saved credential stores. Linux Secret Service requires a session
D-Bus. On Unix, if the store is unavailable, login automatically uses a private,
unencrypted file under `$XDG_STATE_HOME/widefleet/credentials/`, or
`~/.local/state/widefleet/credentials/` when that variable is unset. The CLI prints
the chosen location and reuses it for later commands. This automatic fallback
is part of the unreleased browser-login changes.

To choose the location explicitly, select a Unix session file. This requires CLI 0.2.1 or newer; `widefleet --help` lists `--session-file`. These commands use Bash syntax:

```sh
export PLATFORM_SESSION_FILE="$HOME/.local/state/widefleet/session.json"
widefleet login --scope platform:read
widefleet whoami
widefleet apps
```

Open the printed verification URL in your browser and approve the code. The CLI handles authorization and token exchanges, binds the token to this platform's API and requests `offline_access` for automatic renewal. The example grants read access; request `platform:read platform:write` when deployment is needed. In Fish, use `set -gx` instead of `export`, for example `set -gx PLATFORM_SESSION_FILE "$HOME/.local/state/widefleet/session.json"`.

The file contains **unencrypted access and refresh tokens**. Use a location outside app projects, shared folders and exported artifacts. The CLI creates missing parent directories with mode `0700` and credential files with mode `0600`; it rejects existing directories or files that grant group/other access, and rejects symlinked or hard-linked credential files. These permissions do not protect against processes running as the same user or an administrator. Keep one file per platform origin; the CLI refuses to use a file with another origin. Use `--session-file /absolute/path/session.json` to override the environment variable for a command. Keep the same selection for subsequent commands, including `widefleet logout`.

Saved sessions renew automatically, including during commands that poll for results. Refresh is serialized across processes and updated credentials are written atomically. `widefleet logout` revokes the saved refresh token before deleting the session file; if revocation fails, the file remains so logout can be retried. The companion `.lock` file contains no tokens and remains in place. Deleting a session file manually does not revoke the server-side credentials. An ephemeral environment needs a new login when its session file is lost.

For externally managed credentials, `PLATFORM_ACCESS_TOKEN` remains available. It takes precedence over either saved credential store for API commands, bypasses the store and does not renew automatically. `login` and `logout` still act on the selected saved store. For a manual device flow, include `resource=PLATFORM_URL/api/v1` in the initial `/api/auth/device/code` request; request `offline_access` as well if the external workflow needs a refresh token. Token requests use `application/x-www-form-urlencoded` and an `Origin` header matching `PLATFORM_URL`. A token issued without the API resource is not accepted by `/api/v1`, even before it expires.
