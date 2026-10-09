---
title: CLI authentication
description: Credential stores, headless sessions, token renewal and external credentials.
---

Use `widefleet login` to approve a device code in your browser. The default scopes are `platform:read platform:write`; select additional scopes explicitly when needed. On Linux, the default OS credential store requires an available, unlocked Secret Service and a session D-Bus.

## Headless login

In a Unix shell without an OS credential store, explicitly select a session file. This requires CLI 0.2.1 or newer; `widefleet --help` lists `--session-file`. These commands use Bash syntax:

```sh
export PLATFORM_URL=https://platform.example.com
export PLATFORM_SESSION_FILE="$HOME/.local/state/widefleet/session.json"
widefleet login --scope platform:read
widefleet whoami
widefleet apps
```

Open the printed verification URL in your browser and approve the code. The CLI handles the device and token exchanges, binds the token to this platform's API and requests `offline_access` for automatic renewal. The example grants read access; request `platform:read platform:write` when deployment is needed. In Fish, use `set -gx` instead of `export`, for example `set -gx PLATFORM_SESSION_FILE "$HOME/.local/state/widefleet/session.json"`.

The file contains **unencrypted access and refresh tokens**. Use a location outside app projects, shared folders and exported artifacts. The CLI creates missing parent directories with mode `0700` and credential files with mode `0600`; it rejects existing directories or files that grant group/other access, and rejects symlinked or hard-linked credential files. These permissions do not protect against processes running as the same user or an administrator. Keep one file per platform origin; the CLI refuses to use a file with another origin. Use `--session-file /absolute/path/session.json` to override the environment variable for a command. Keep the same selection for subsequent commands, including `widefleet logout`.

Saved sessions renew automatically, including during commands that poll for results. Refresh is serialized across processes and updated credentials are written atomically. `widefleet logout` revokes the saved refresh token before deleting the session file; if revocation fails, the file remains so logout can be retried. The companion `.lock` file contains no tokens and remains in place. Deleting a session file manually does not revoke the server-side credentials. An ephemeral environment needs a new login when its session file is lost.

For externally managed credentials, `PLATFORM_ACCESS_TOKEN` remains available. It takes precedence over either saved credential store for API commands, bypasses the store and does not renew automatically. `login` and `logout` still act on the selected saved store. For a manual device flow, include `resource=PLATFORM_URL/api/v1` in the initial `/api/auth/device/code` request; request `offline_access` as well if the external workflow needs a refresh token. Token requests use `application/x-www-form-urlencoded` and an `Origin` header matching `PLATFORM_URL`. A token issued without the API resource is not accepted by `/api/v1`, even before it expires.
