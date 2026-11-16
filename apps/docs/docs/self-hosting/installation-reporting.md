---
title: Installation reporting
description: Usage insights that help improve Widefleet.
lastModified: 2026-11-16
---

Usage insights help us focus on the features you use and make Widefleet more reliable. Installations share usage statistics and sanitized error reports by default. You can configure these two categories independently.

## What helps us improve Widefleet?

- **Usage:** counts of apps, organizations, previews, agents and active management users; deployment outcomes and durations; CLI command categories, results and durations.
- **Configuration:** component versions, operating system and architecture, storage and authentication types, TLS and logging availability, and counts of configured network policies and app connections.
- **Reliability:** error categories and sanitized locations in Widefleet code.

Installations and agents report at startup and hourly. Operations, CLI commands and errors are reported as they occur.

Reports are limited to counts, technical metadata and sanitized code locations. App contents, log messages, credentials, command arguments and personal account details are excluded. [Application logs](/self-hosting/runtime-logs) stay in your infrastructure.

## Where do reports go?

Reports go to PostHog in the EU. A random, persistent ID groups reports from the same installation. The CLI uses a separate random ID and can report before login. Both IDs are independent of account details and hostnames; person profiles and GeoIP enrichment are disabled.

Apps and commands continue working if report delivery is unavailable. Settings apply to future reports; previously sent reports remain stored.

## Installation settings

Control reporting in your deployment environment file. Set a category to `true` to share reports or `false` to turn it off:

```dotenv
PLATFORM_USAGE_REPORTING=false
PLATFORM_CRASH_REPORTING=false
```

This example turns off both categories. Apply changes by recreating management and the agent through your normal deployment process.

Explicit environment values take precedence over saved preferences. Otherwise, Widefleet uses the saved preferences, which default to enabled and survive updates. Reporting is off in the local demo and CI.

Administrators can read or update saved preferences through `GET` or `PUT /api/v1/reporting`. `GET /api/v1/reporting/preview` shows a sample usage payload. These [API endpoints](/reference/api) require installation administrator access.

## CLI settings

CLI preferences are separate from installation settings:

```sh
widefleet telemetry status
widefleet telemetry disable
widefleet telemetry enable
```

Use `--usage` or `--crashes` with `enable` or `disable` to change one category. For scripts, `WIDEFLEET_TELEMETRY_DISABLED=1` disables both.

To inspect CLI events without sending them, set `WIDEFLEET_TELEMETRY_DEBUG=1`. Events are printed to stderr; normal command output and exit status are preserved.
