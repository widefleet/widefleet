---
name: WHOOP
description: Read WHOOP cycles, recoveries, sleeps, workouts and body measurements, with typed results.
secretHelp:
  WHOOP_CLIENT_ID: >-
    Open your app in [WHOOP Developer Dashboard](https://developer-dashboard.whoop.com/) and copy its client ID.
  WHOOP_CLIENT_SECRET: >-
    Use the client secret for the same application in [WHOOP Developer Dashboard](https://developer-dashboard.whoop.com/).
---

Read WHOOP cycles, recoveries, sleeps, workouts and body measurements from your
agents and apps. Each person connects their own WHOOP membership.

## Set up

1. Create an app in the [WHOOP Developer
   Dashboard](https://developer-dashboard.whoop.com/) with the scopes
   `read:profile`, `read:body_measurement`, `read:cycles`, `read:recovery`,
   `read:sleep` and `read:workout`.
2. Add `https://YOUR-APP-URL/auth/callback/whoop` as a redirect URL. You can add it
   once the app is installed and its URL is known.
3. Enter the client ID and secret as `WHOOP_CLIENT_ID` and `WHOOP_CLIENT_SECRET` and
   install the template.

Then open the app and connect your WHOOP account. A new WHOOP app connects up to 10
members; request a higher tier in the Developer Dashboard for more.

## Use it

Ask your agent, for example "How did I sleep this week?". To call it from your own
app, connect it from the app's directory:

```sh
widefleet connect whoop --as WHOOP
```

Each WHOOP operation is a method, such as `listCycles`, `getCycleRecovery` and
`listSleeps`. See [using a template
app](https://widefleet.com/docs/guides/app-templates#use-from-agents-and-apps) for
calls, approvals and results.
