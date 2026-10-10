---
title: CLI configuration
description: Inspect, change and distribute the platform URL used by the Widefleet CLI.
---

These commands require a CLI build with company discovery: `widefleet login --help`
lists `--email` and `--domain`.

The CLI remembers the platform URL after a successful login. Credentials stay
in the operating system's credential store or the explicitly selected session file.

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
  "platform_url": "https://platform.example.com"
}
```

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

## Discover your company

With no configured URL, `widefleet login` asks for a work email or company domain
in an interactive terminal. Agents and noninteractive shells can supply either:

```sh
widefleet login --email employee@example.com
# Or, when the company domain is already known:
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

Only the domain is used in discovery requests. The email's local part is neither
sent nor saved, and discovery requests carry no login credentials. There is no
fallback to a public DNS provider or a Widefleet-operated directory. The DNS
resolver and the company's HTTPS endpoint can observe the requests they receive.

Regular API commands use the selected URL and do not rediscover it. Missing
configuration directs the employee or agent to login. Automatic company-domain
detection from a network or VPN is not implemented.

## Company setup

See [company setup](/self-hosting/company-setup) for distributing configuration
to managed agents and employee computers.
