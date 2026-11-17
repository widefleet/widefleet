---
title: CLI configuration
description: Inspect, change and distribute the platform URL used by the Widefleet CLI.
lastModified: 2026-10-23
---

Browser-based destination selection and automatic Unix credential-file fallback
require CLI **0.4.3 or newer**. Company discovery with `--email` or `--domain`
and saved configuration require CLI 0.3.2 or newer. Check `widefleet --version`;
`widefleet login --help` lists `--email` and `--domain`.

The CLI remembers the platform URL after a successful login. Credentials stay
in the operating system's credential store or a private Unix credential file.
See [CLI authentication](/reference/authentication) for storage and renewal.

## Select an organization

Organization selection requires platform and CLI **0.4.0 or newer**. Check `widefleet --help` for `--organization`.

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

For several commands in the same Bash session, set `PLATFORM_ORGANIZATION` to the
selected ID. `--organization` overrides the environment variable for one command.
This preference is not saved in the CLI configuration or credential store.
Browser organization changes do not change the CLI target. The CLI sends the
selection on every API request, including uploads and deployment polling.

A standard installation uses its own organization when no selection is supplied.
Otherwise, if exactly one organization is available, commands such as
`widefleet deploy` use it automatically without `--organization`. With several
available organizations, select one explicitly; without a choice, the server
returns `ORGANIZATION_REQUIRED`. With no available organizations, ask an
administrator to grant access.

An explicitly selected organization that is unavailable or whose membership was
removed fails with `403`; that selection is never replaced by another organization.
Run `widefleet organizations` again and choose an available ID, or ask your
administrator to restore access.

## Inspect or change the URL

```sh
widefleet config show
widefleet config set-url https://platform.example.com
widefleet config unset-url
```

These commands work without a login. `show` returns JSON with the effective URL,
its source and configuration file paths. `set-url` saves an address without
authenticating. `unset-url` clears the saved address; an administrator's default
can still apply. Neither command changes or removes credentials.

## Files and precedence

The CLI selects the first configured URL from:

1. The `--url` argument.
2. The `PLATFORM_URL` environment variable.
3. The employee's saved configuration file.
4. The managed configuration file supplied by IT.

Login uses the configured address directly, including an explicitly configured
Cloud address. With no configured address, `widefleet login` starts in Cloud and
uses your email to find an installation. After login, API commands use the saved
address.

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

If no default configuration directory is available, login with an explicit
`--url` or `PLATFORM_URL` still works. The CLI explains that the URL cannot be
saved; keep supplying the URL or select a writable `--config-file` to remember it.

The JSON format is:

```json
{ "platform_url": "https://platform.example.com" }
```

Use `--organization` or `PLATFORM_ORGANIZATION` to select the working
organization for API commands.

Use an HTTPS origin without a path, query, fragment or credentials. HTTP on a
loopback address is allowed for local development. An invalid file reports an
error instead of falling back to another installation.

`--config-file PATH` or `PLATFORM_CONFIG_FILE` replaces both default file paths
with one selected file. The flag takes precedence over the environment variable.
This is useful for separate environments and agent sandboxes. The selected file
is also where successful login and `config set-url` save the URL; otherwise they
write the user file. The CLI never updates the managed default.

An explicit URL flag or environment variable still overrides a saved URL. Check
`widefleet config show` if changing the file appears to have no effect. Logging
out removes the selected session but retains the URL for the next login.

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

These explicit discovery options select a company even when a URL is saved. They
cannot be combined with `--url` or `PLATFORM_URL`; remove that override first.
Discovery does not change the saved URL until login succeeds.

The CLI checks the company's DNS TXT record, then its HTTPS discovery document.
If neither provides an address, Cloud resolves the domain and supplies the
company address or the Cloud default. These requests use only the domain from
`--email`. A successful local lookup connects directly to the company.

If discovery reports an invalid or conflicting record, ask IT to correct it.
To connect to a known address directly, use
`widefleet login --url https://platform.example.com`. See
[company setup](/self-hosting/company-setup) for discovery records and network
requirements.

## Company setup

See [company setup](/self-hosting/company-setup) for distributing configuration
to managed agents and employee computers.
