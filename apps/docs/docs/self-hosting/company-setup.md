---
title: Company setup
description: Configure employees' agents and computers so they do not need to know the platform URL.
lastModified: 2026-10-23
---

Employees should be able to run `widefleet login` without knowing the management
URL. Distribute configuration with your existing agent or device setup, or
publish discovery information under your work email domain. These options can
be combined. Use CLI **0.4.3 or newer** for browser-based discovery;
`widefleet login --help` lists `--email` and `--domain` for explicit discovery.
The same setup flow applies on Windows, macOS and Linux. See
[CLI configuration](/reference/cli-configuration) for earlier-version support.

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

`widefleet login --domain example.com` queries the fully qualified name `_widefleet.example.com.` through the
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

If you use multiple email domains, publish discovery for each one. Use the exact
domain from employees' email addresses. When publishing both DNS and HTTPS,
keep their platform URLs consistent. A valid DNS record takes precedence.

Publish DNS and website changes through your normal versioned infrastructure
and deployment process. Allow the agent to reach the company's discovery website
and platform API through its network policy, including VPN access where needed.

### Employees arriving at Widefleet Cloud

Employees can enter their work email at `https://app.widefleet.com` to reach
your installation through the same DNS record or HTTPS document. If discovery
finds no company address, they continue in Cloud. Company invitation and
organization links open their intended installation directly.

Publish discovery where public resolvers and Cloud can read it. For private DNS,
distribute a platform URL or use `widefleet login --domain example.com` from the
company network. The installation itself may require a VPN; both the employee's
browser and the agent's CLI environment need access.

To connect employees directly to your installation independently of public
discovery, distribute its URL using [managed configuration](#managed-computers).

## Agent instructions and verification

Have the agent run `widefleet login`, share the browser link and keep the command
running while the employee signs in and approves the device code. After login
succeeds, the agent can continue the task. See
[agent login](/reference/authentication#agent-login).

Verify the setup from each supported environment, including remote sandboxes:

```sh
widefleet config show
widefleet whoami
```

The saved address should match your installation, and `whoami` should identify
the employee.

Credentials remain in the employee's credential store or private Unix file. See
[credential storage](/reference/authentication).
