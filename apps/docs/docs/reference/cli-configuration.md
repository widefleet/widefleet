---
title: CLI configuration
description: Inspect, change and distribute the platform URL used by the Widefleet CLI.
lastModified: 2026-10-23
---

Company discovery and saved configuration require CLI 0.3.2 or newer. Check
`widefleet --version`; `widefleet login --help` lists `--email` and `--domain`.

Browser-first Cloud login, resumable authorization, automatic Unix credential
files and saved organization selection below are **unreleased**. They require a
CLI release containing these changes and upgraded Cloud and destination servers.
CLI 0.4.0 supports company discovery and saved URLs, but requires an explicit
Cloud URL when no company discovery record exists. Older self-hosted servers
remain usable through direct device login with `--url`.

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
`application.admin` grants application and connector administration within that scope;
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
its source, saved working organization and configuration file paths. `set-url` saves an address without
authenticating. `unset-url` clears the saved address; an administrator's default
can still apply. Neither command changes or removes credentials.

## Files and precedence

The CLI selects the first configured URL from:

1. The `--url` argument.
2. The `PLATFORM_URL` environment variable.
3. The employee's saved configuration file.
4. The managed configuration file supplied by IT.

With none configured, `login` starts at `https://app.widefleet.com`. Other API
commands ask you to run `widefleet login`; they do not send work to Cloud before
login chooses and saves a destination.

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
{
  "platform_url": "https://platform.example.com",
  "organization_id": "example-company"
}
```

`organization_id` is optional. Browser login saves the organization selected on
the approval page. `--organization` or `PLATFORM_ORGANIZATION` overrides that
default for API commands. It chooses the working organization, without expanding
or narrowing the token's permissions. `config set-url` clears the saved
organization; an explicit URL override does not inherit the saved organization's
ID from another installation.

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

Run `widefleet login` without any URL, email or domain. If a self-hosted URL is
already configured, login connects there directly. Otherwise the CLI prints a
Cloud browser link and matching code. Open the link in your own browser, even
when the CLI is running in a remote agent sandbox.

Enter your email in the browser. Cloud resolves its domain's published TXT or
HTTPS discovery information and sends you to the selected installation. Sign in
there, check the platform and matching code, select your working organization
and approve. The CLI exchanges the authorization code directly at that
installation, then saves its URL and selected organization. No Cloud account is
required for a discovered self-hosted installation.

Cloud sees the entered email, selected installation and a short-lived
authorization code bound to the CLI's PKCE secret. That secret, access token and
refresh token stay out of the Cloud handoff for self-hosted login. Cloud needs
public discovery records; the browser and CLI need network access to the selected
installation. The CLI does not use a localhost callback.

A valid company TXT record takes precedence. Without one, Cloud uses a valid
HTTPS discovery document when available and otherwise continues in Cloud. A
missing document, an ordinary HTML page, redirects, DNS/network outages and
unusable HTTPS responses do not prevent Cloud login. Redirects are not followed;
private discovery addresses and oversized responses are not used.

Malformed or conflicting published Widefleet TXT records still require IT to
correct them. A configured or already selected company platform remains the
target even when it is unavailable; its authentication requests never fall back
to another installation. To avoid initial Cloud routing during discovery outages,
IT can distribute the company URL in CLI configuration.

A request lasts 30 minutes. After browser approval, resume the CLI within nine
minutes to exchange the code. See [resuming login](/reference/authentication#agents-and-interrupted-login)
for commands and machine-readable status.

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

The CLI queries `_widefleet.example.com` for a TXT record through the operating
system's DNS resolver. If no record exists, DNS fails, or it takes longer than
five seconds, the CLI requests `https://example.com/.well-known/widefleet`.
The HTTPS request uses the environment's proxy settings and has a ten-second
timeout. It requires a valid TLS certificate, accepts at most 8 KiB of JSON and
does not follow redirects. Malformed or conflicting TXT records stop discovery
without trying a second source. A valid TXT record takes precedence over HTTPS.

When local discovery provides no usable company URL, the CLI asks
`https://app.widefleet.com/api/platform-discovery` to resolve the domain using the
same rules as the Cloud browser flow. This includes an absent website document,
HTML pages, redirects and network failures. A company result starts direct device
authorization; a Cloud result starts the browser flow above, where the employee
enters their email. The URL is saved only after login succeeds.

Invalid or conflicting TXT records remain configuration errors. If the shared
Cloud endpoint itself is unavailable or returns an invalid result, retry or use
an explicit `--url`. The CLI never follows a discovery redirect or weakens TLS
verification.

Only the domain is used in these optional CLI discovery requests. The email's local part is
neither sent nor saved, and discovery requests carry no login credentials.
The DNS resolver and company website can observe their requests. Cloud also
receives the domain when resolving an unavailable or absent local company target. Valid
local company discovery, saved URLs and managed configuration connect directly
without contacting Cloud.

Regular API commands use the selected URL and do not rediscover it. Missing
configuration directs the employee or agent to login. Automatic company-domain
detection from a network or VPN is not implemented.

## Company setup

See [company setup](/self-hosting/company-setup) for distributing configuration
to managed agents and employee computers.
