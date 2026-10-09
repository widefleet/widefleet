---
title: Installation reporting
description: Control usage reporting and understand the data sent to Widefleet.
---

Widefleet shares product usage, configuration metadata and sanitized error reports with the Widefleet team through the existing `widefleet` PostHog project in the EU. Reporting is enabled initially and has two independent opt-outs. This is separate from [application runtime logs](/self-hosting/runtime-logs), which stay in the operator's infrastructure.

## Operator controls

Administrators can disable **Share usage and configuration** and **Share error reports** under **Settings → Privacy**. The same section shows the random installation ID and a preview of the usage payload. The setup page explains reporting before the first account is created. Existing installations receive the same defaults when the migration runs.

To disable reporting before starting the installation, set these variables in the deployment environment file:

```dotenv
PLATFORM_USAGE_REPORTING=false
PLATFORM_CRASH_REPORTING=false
```

An explicitly configured `true` or `false` overrides the corresponding management setting. An unset or empty variable leaves that setting editable. The versioned Compose configuration forwards these variables to management and the agent. Recreate the affected services through the normal deployment process when changing environment variables. The local demo and CI disable reporting.

The CLI has its own local identity and preferences, independent of any login or installation:

```sh
widefleet telemetry status
widefleet telemetry disable
widefleet telemetry enable --usage
widefleet telemetry disable --crashes
```

The state file is `widefleet/telemetry.json` below `XDG_STATE_HOME`, `LOCALAPPDATA`, or `$HOME/.local/state`. It contains only a random UUID and two preferences. A sibling `telemetry.lock` file serializes preference changes, and running commands re-read preferences before sending. A missing/unreadable state directory or invalid state file disables automatic reporting. `WIDEFLEET_TELEMETRY_DISABLED=1` disables both CLI categories; `PLATFORM_USAGE_REPORTING=false` and `PLATFORM_CRASH_REPORTING=false` independently disable them. A `CI` environment variable disables native reporting too.

Use `WIDEFLEET_TELEMETRY_DEBUG=1` to print the CLI's sanitized events to stderr **without transmitting them**. Normal command output and exit status are preserved. The telemetry management commands do not report their own use.

## Data and transport

| Event                   | Contents                                                                                                                                                                                                                                                        | Cadence                                                                                     |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `installation_snapshot` | App/fleet/preview/enabled-agent counts, configured network policies and capability bindings, connector count, active management-user count, control-plane/runtime versions, OS/architecture, storage/authentication/TLS categories and app-logging availability | At management startup and hourly                                                            |
| `operation_completed`   | Deploy/rollback/runtime update/runtime rollback/connector/configuration/deletion, result, attempt and elapsed milliseconds from enqueue to completion, including queue time                                                                                     | After a committed completion; repeated receipts do not emit another event                   |
| `agent_heartbeat`       | Agent version, OS and architecture                                                                                                                                                                                                                              | At agent startup and hourly                                                                 |
| `cli_command_completed` | Fixed command category, result, duration, CLI version and OS/architecture                                                                                                                                                                                       | Command completion, including failures before login                                         |
| `$exception`            | Fixed error category, Widefleet source locations, component and version                                                                                                                                                                                         | Unexpected management/UI failures, agent operation failures and native panics, CLI failures |

Management and agent events use `installation:<random UUID>` as their PostHog distinct ID. The UUID survives restarts and updates in the installation database. CLI events use a separate `cli:<random UUID>`. Neither identity is derived from a hostname, account or email address. Person profiles and GeoIP enrichment are disabled.

Management user IDs are counted only in a bounded local set and never transmitted. Its observation window starts at process startup or a preference change and resets after each hourly snapshot. It is capped at 100,000 distinct IDs; the payload identifies this cap. With multiple management processes, counts describe each process's observation window and must not be summed as installation-wide distinct users.

Agents and the management UI send bounded, authenticated reports to their Control Plane. Only the Control Plane contacts `https://eu.i.posthog.com`. The CLI contacts that host directly, including when no platform login exists. No administrator or private PostHog API key is shipped: the embedded project token is a public ingestion token. No PostHog browser SDK, autocapture, session replay or feature-flag polling is enabled.

The schema excludes user IDs, emails, domains, app names, request URLs, command arguments, environment values, credentials, app contents, log messages and free-form exception messages. Frames keep only paths within Widefleet source/build files, code function names where available, and line/column numbers. Browser source maps are moved outside the publicly served directory during the build; the Control Plane resolves its own source locations locally before transmission. Source text and source maps are not uploaded. Native release builds retain line tables for panic source locations. Returned native errors carry the location where they were constructed or converted, rather than a stack captured after the operation has already returned.

## Delivery behavior

Reporting is best effort. The PostHog SDK keeps at most 100 events per category in memory, flushes at 20 events or after ten seconds, uses a 1.5-second request timeout and does not immediately retry failed requests. The SDK can retain a failed network batch in its bounded memory buffer until another flush; events keep their UUIDs for deduplication. There is no disk or database event queue. The only reporting database state is the installation UUID, preferences and their revision; the job rollback flag records operation intent.

Changing preferences invalidates pending SDK batches, including those held by another management process. Every outbound batch rechecks the effective settings and revision. Requests already sent cannot be recalled. The server caps crash reports at 100 per hour, the browser at five per minute, and the agent spaces error reports by at least twelve seconds. Shutdown attempts to drain reporting for at most two seconds. Failures and overload drop events without failing product operations.

Agent diagnostics are lost if the Control Plane is unreachable. Hard termination, out-of-memory failures, startup failures before management has opened its installation database, and operating-system kills may leave no report. Browser source locations from an older tab remain generated locations if the running server no longer has that build's map. These limits are intentional consequences of best-effort reporting without a durable queue.
