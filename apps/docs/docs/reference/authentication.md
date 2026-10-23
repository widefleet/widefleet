---
title: CLI authentication
description: Credential stores, headless sessions, token renewal and external credentials.
lastModified: 2026-10-23
---

Run `widefleet login` and open the printed link in your browser. With no configured
platform, the browser asks for your email and routes to your installation. Any
configured URL starts device login there directly, including Cloud. Check the
platform and code before approving. The default scopes are
`platform:read platform:write`; select additional scopes explicitly when needed.
See [CLI configuration and availability](/reference/cli-configuration).

## Agent login

An agent starts `widefleet login` without needing your email or platform URL.
It keeps the command running and presents its browser link. With no configured
platform, you enter your email in the browser; the CLI then prints the device
verification link and code for the discovered installation. Approve that code
in your own browser. Configured targets start device login immediately.

The agent can run the waiting command in a background terminal session while
you sign in. After it exits successfully, verify access with `widefleet whoami`
and continue the requested task. If the command is stopped, denied or expires,
run `widefleet login` again. Open login requests are not saved for resumption.
Already completed logins remain available through their saved credentials.

The Cloud discovery request expires after 30 minutes. Device login uses the
expiry returned by its server. Saving the destination can fail after tokens have
been saved; the error explains how to supply `--url` or repair the configuration.

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
