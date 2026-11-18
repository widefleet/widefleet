---
title: CLI configuration
description: Inspect, change and distribute the platform URL used by the Widefleet CLI.
lastModified: 2026-11-18
---

The CLI remembers the platform URL after a successful login. Credentials stay
in the operating system's credential store or a private Unix credential file.
See [CLI authentication](/reference/authentication) for storage and renewal.

## Inspect or change the URL

```sh
widefleet config show
widefleet config set-url https://platform.example.com
widefleet config unset-url
```

These commands work without a login and leave credentials unchanged. `show`
returns JSON with the effective URL, its source and configuration file paths.
`set-url` saves an address without authenticating. `unset-url` clears the saved
address; an administrator's managed default then applies, if one exists.

## Files and precedence

The CLI selects the first configured URL from:

1. The `--url` argument.
2. The `PLATFORM_URL` environment variable.
3. The employee's saved configuration file.
4. The managed configuration file supplied by IT.

If editing a file appears to have no effect, run `widefleet config show` to see
which source is active.

Login uses the configured address directly, including an explicitly configured
Cloud address. With no configured address, `widefleet login` starts in Cloud and
uses your email to find an installation. After login, API commands use the saved
address. Logging out removes the session and keeps the URL for the next login.

| Operating system | Employee's file                                                                       | Managed file                                         |
| ---------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Windows          | `%APPDATA%\widefleet\config.json`                                                     | `%PROGRAMDATA%\widefleet\config.json`                |
| macOS            | `~/Library/Application Support/widefleet/config.json`                                 | `/Library/Application Support/widefleet/config.json` |
| Linux            | `$XDG_CONFIG_HOME/widefleet/config.json`, otherwise `~/.config/widefleet/config.json` | `/etc/widefleet/config.json`                         |

Windows uses the `APPDATA` environment variable for the employee's file and
`PROGRAMDATA`, when available, for the managed file. macOS uses `HOME` for the
employee's file. On Linux, an unset or empty `XDG_CONFIG_HOME` falls back to `HOME`.
These directory values must be absolute. Run `widefleet config show` inside the
agent's environment to inspect the actual paths.

The JSON format is:

```json
{ "platform_url": "https://platform.example.com" }
```

Use an HTTPS origin without a path, query, fragment or credentials. HTTP on a
loopback address works for local development. An invalid file stops the command
with an error rather than falling back to another installation.

`--config-file PATH` or `PLATFORM_CONFIG_FILE` replaces both default file paths
with one selected file; the flag takes precedence over the environment variable.
Use it for separate environments and agent sandboxes. Successful login and
`config set-url` save the URL to the selected file, or to the employee's file by
default. The CLI leaves the managed file unchanged.

With no default configuration directory, login with an explicit `--url` or
`PLATFORM_URL` still works and the CLI reports that it could not save the URL.
Keep supplying the URL, or select a writable `--config-file` to remember it.

## Start in the browser

Run `widefleet login` and open its link in your browser. With no configured
platform, enter your email to find your company's installation or continue in
Widefleet Cloud. Sign in, check the device code and approve. Keep the CLI running
until it confirms the connection and saves the selected address.

For a private installation, connect both your browser and the CLI environment to
the required network or VPN. A configured company URL connects directly; see
[files and precedence](#files-and-precedence) to inspect or change it.

If login is interrupted or expires, run `widefleet login` again. When using an
agent, follow [agent login](/reference/authentication#agent-login).

## Discover locally when needed

If the company domain is already known, these optional flags run discovery from
the CLI environment. They are useful for private DNS and direct self-hosted login:

```sh
widefleet login --email employee@example.com
widefleet login --domain example.com
```

These discovery options select a company even when a URL is saved, and the saved
URL changes only after login succeeds. Use them without `--url` or `PLATFORM_URL`;
remove that override first.

The CLI checks the company's DNS TXT record, then its HTTPS discovery document.
If neither provides an address, Cloud resolves the domain and supplies the
company address or the Cloud default. These requests send only the domain from
`--email`. A successful local lookup connects directly to the company.

If discovery reports an invalid or conflicting record, ask IT to correct it.
To connect to a known address directly, use
`widefleet login --url https://platform.example.com`. See
[company setup](/self-hosting/company-setup) for discovery records and network
requirements.

## Select an organization

After logging in, list the organizations available to your account:

```sh
widefleet organizations
```

The JSON response contains each organization's `id`, `name`, `slug` and your `role`.
Use an `id` from that response in place of `ORGANIZATION_ID`:

```sh
widefleet --organization ORGANIZATION_ID whoami
widefleet --organization ORGANIZATION_ID apps
```

`whoami` includes the selected organization under `application.organizationId`.
`application.admin` grants app connection administration within that scope;
the top-level `admin` field represents installation administration.

For several commands in the same shell session, set `PLATFORM_ORGANIZATION` to the
selected ID. `--organization` overrides the environment variable for one command.
The CLI sends the selection on every API request, including uploads and deployment
polling. The selection lives only in the flag or environment variable, so browser
organization changes leave the CLI target unchanged.

Without a selection, the CLI uses:

- On a standard installation, the installation's own organization.
- Otherwise, the only available organization, when there is exactly one.

With several available organizations, select one explicitly; otherwise the server
returns `ORGANIZATION_REQUIRED`. With none, ask an administrator to grant access.

Widefleet uses only the organization you select. A selection that is unavailable,
or whose membership was removed, fails with `403`. Run `widefleet organizations`
again and choose an available ID, or ask your administrator to restore access.

## Company setup

See [company setup](/self-hosting/company-setup) for distributing configuration
to managed agents and employee computers.
