---
title: Company setup
description: Configure employees' agents and computers so they do not need to know the platform URL.
lastModified: 2026-10-23
---

Employees should be able to run `widefleet login` without knowing the management
URL. Distribute configuration with your existing agent or device setup, or
publish discovery information under your work email domain. These options can
be combined. Use CLI 0.3.2 or newer; `widefleet login --help` lists `--email` and
`--domain`. The same setup flow applies on Windows, macOS and Linux.

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

If you use multiple email domains, publish discovery for each one. The CLI uses
the exact supplied domain; it does not try parent domains or guess a company.
When publishing both DNS and HTTPS, keep their platform URLs consistent. DNS
takes precedence when it returns a valid record.

Publish DNS and website changes through your normal versioned infrastructure
and deployment process. Allow the agent to reach the company's discovery website
and platform API through its network policy. A public discovery record does not
make a private platform reachable from a cloud sandbox.

### Employees arriving at Widefleet Cloud

Cloud sign-in can use the same public DNS record or HTTPS document to route
employees who arrive at `https://app.widefleet.com`. After an employee enters a
work email, Cloud checks that domain and opens the published platform's sign-in
page before requesting a Cloud email code. No registration of the company in a
separate Widefleet directory is required. See [availability and Cloud defaults](/reference/cli-configuration).

Publish discovery where public resolvers and the Cloud service can read it.
Private DNS continues to work for local CLI discovery, but Cloud cannot use a
company-only resolver or fetch a private discovery website. The published
platform itself may still require the employee's VPN. Both the browser and the
agent's CLI environment need access to it.

For the new default CLI flow, Cloud first creates a browser request. The employee
enters their email there; routing happens before authorization starts at the
selected installation. Upgrade that installation and Cloud to support the CLI's
PKCE authorization and organization selection before rolling out the new CLI.
An older self-hosted server still supports direct login with its configured URL.
No callback listener on the employee's computer or agent sandbox is needed.

Explicit organization sign-in links retain their target, including for guests
whose email belongs to another company. Existing device grants and OAuth or
invitation continuations are not forwarded between installations. If a device
login was started at the wrong platform, the page explains how to restart it
with `widefleet login --domain example.com`.

## Agent instructions and verification

Have the agent run `widefleet login --no-wait --json` when it needs authentication.
It presents `verification_uri` and `user_code` to the employee, who completes the
browser flow. The agent then checks `widefleet login --status --json` until
`status` is `connected` and continues the deployment. It does not need to know
the employee's email or choose between Cloud and self-hosting.

For private-only discovery, distribute the platform configuration or a known
`widefleet login --domain example.com` command. A managed file is a default,
not a policy lock: explicit overrides and the employee's saved URL take precedence.

Verify login from each supported environment, including remote sandboxes. After
success, `widefleet config show` reports the saved URL and working organization;
`widefleet whoami` identifies the employee. Configuration contains no tokens.
Credentials remain in the employee's credential store or private Unix file. See
[storage and interrupted login](/reference/authentication).
