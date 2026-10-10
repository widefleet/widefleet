---
title: Company setup
description: Configure employees' agents and computers so they do not need to know the platform URL.
---

Employees should be able to run `widefleet login` without knowing the management
URL. Distribute configuration with your existing agent or device setup, or
publish discovery information under your work email domain. These options can
be combined. Use a CLI build whose `widefleet login --help` lists `--email` and
`--domain`; the same setup flow applies on Windows, macOS and Linux.

## Preconfigured agents

Set `PLATFORM_URL=https://platform.example.com` in the environment where the
agent runs the CLI, or distribute a CLI configuration file there. An instruction
in the agent's prompt alone does not configure its shell environment.

For agents running in containers or remote sandboxes, supply the setting inside
that environment. A file on the employee's laptop is not automatically visible
to a remote agent. Each employee uses their own login; do not distribute tokens
with the company configuration.

## Managed computers

Distribute the following JSON with your device-management tool. Make the managed
file readable by employees and writable only by administrators:

| Operating system where the CLI runs | Managed file                                         |
| ----------------------------------- | ---------------------------------------------------- |
| Windows                             | `%PROGRAMDATA%\widefleet\config.json`                |
| macOS                               | `/Library/Application Support/widefleet/config.json` |
| Linux                               | `/etc/widefleet/config.json`                         |

```json
{
  "platform_url": "https://platform.example.com"
}
```

Any local agent running the CLI can use this default. An employee's saved URL or
an explicit URL override takes precedence. Run `widefleet config show` in the
agent's environment to check which address it will use.

For a different location, set `PLATFORM_CONFIG_FILE` to the file path. That file
replaces both default configuration files and must be writable if login should
remember the URL there. See [CLI configuration](/reference/cli-configuration) for
all paths, commands and precedence rules.

## Discovery from a work email or company domain

For employees using `employee@example.com`, publish either of the following.
An installation on another domain is supported; the discovery value identifies
its HTTPS management origin.

### DNS TXT record

Create this record in the `example.com` DNS zone:

| Field   | Value                              |
| ------- | ---------------------------------- |
| Type    | `TXT`                              |
| Name    | `_widefleet`                       |
| Content | `url=https://platform.example.com` |

The CLI queries the fully qualified name `_widefleet.example.com.` through the
operating system's resolver. Publish a TXT record directly at that name. Strings
within one TXT record are concatenated; separate records must identify the same
platform URL. A missing record or unavailable resolver allows HTTPS fallback.
A malformed record or multiple distinct URLs reports an error instead.

Private DNS records work only when the agent's execution environment can reach
the company resolver. Some agent sandboxes allow HTTPS through a proxy but block
native DNS queries; publish the HTTPS file for those environments.

### Company-hosted HTTPS file

Serve this JSON at exactly `https://example.com/.well-known/widefleet`:

```json
{
  "platform_url": "https://platform.example.com"
}
```

Use `Content-Type: application/json` and a valid TLS certificate. Serve the file
without authentication or redirects, including redirects to `www.example.com`.
Keep it below 8 KiB. The URL must be an HTTPS origin without a path, query,
fragment or embedded credentials. The file is hosted on the work email domain;
publishing it only on the platform's own domain does not let employees find it.

If you use multiple email domains, publish discovery for each one. The CLI uses
the exact supplied domain; it does not try parent domains or guess a company.
When publishing both DNS and HTTPS, keep their platform URLs consistent. DNS
takes precedence when it returns a valid record.

Publish DNS and website changes through your normal versioned infrastructure
and deployment process. Allow the agent to reach the company's discovery website
and platform API through its network policy. A public discovery record does not
make a private platform reachable from a cloud sandbox.

## Agent instructions and verification

Have the agent check `widefleet config show` first. If no address is configured,
it can use a work domain or email already available in its authorized context.
Otherwise, it should ask the employee for their work email or company domain,
then run `widefleet login --email employee@example.com` or
`widefleet login --domain example.com`. It should not ask for the platform URL
as the first onboarding step.

Verify login from each environment you support, including remote sandboxes.
After successful login, `widefleet config show` should report the saved URL and
`widefleet whoami` should identify the employee. The configuration file contains
only the URL. Credentials remain in the employee's selected credential store.
