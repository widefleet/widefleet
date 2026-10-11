# Native runtime pitfalls

When upgrading celld or changing event subscriptions, verify these interactions against persistent fleet state. The original failures were observed with celld 0.6.1; the current pin is in [native version validation](../crates/platform-agent/src/native.rs). The public [compatibility reference](https://widefleet.com/docs/reference/runtime-compatibility) owns supported behavior and app-facing limits.

## Reattaching a queue consumer

A retained backlog can remain undelivered after reattaching a consumer even when queue inspection reports `paused: false`. The supported resume command rearms delivery. An explicitly paused queue must remain paused.

The [agent's queue wake-up code](../crates/platform-agent/src/docker.rs) explains the workaround. When upgrading, check both retained backlog delivery and preservation of an operator's pause; an empty-queue test cannot expose this failure.

## Removing the last Cron subscription

An empty Cron list can remove celld's reserved Cron class while its previous alarm still exists. With connector Durable Objects still active, the original failure repeatedly attempted restoration until local storage filled.

The [native schedule construction](../crates/platform-agent/src/fleet.rs) explains why Widefleet retains an impossible calendar expression when no app has a Cron. Keep the old Cron cell in the upgrade test and reactivate it after removing the final subscription, so the test verifies alarm cleanup rather than only the new configuration.

Both cases are covered by the [deployment suite](../apps/control-plane/tests/runtime/deployment.test.ts). Run it using the [runtime test setup](development.md#local-verification) before removing either workaround.
