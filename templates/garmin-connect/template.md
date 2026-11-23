---
name: Garmin Connect
description: Read your own Garmin Connect activities, activity files, sleep, heart rate, HRV, Body Battery and other health data through Garmin's Personal API, with typed results.
---

Connect a Garmin account with a Personal API key and read its Garmin Connect data as
typed methods: activities with their details, workouts and original files, daily
summaries, steps, stress and hydration, sleep, heart rate, heart rate zones, HRV,
Body Battery, SpO2, VO2 max and fitness age, weight and weight goals, nutrition logs,
menstrual cycle data and profile settings. Each signed-in user connects their own
Garmin account. Every method only reads.

## Deploy

Read the [Widefleet app development guide](https://widefleet.com/docs/guides/app-development)
for CLI setup and authentication. Copy this directory into your project and run:

```sh
pnpm install
pnpm test
widefleet deploy
```

Choose the app name in `wrangler.jsonc` before deploying. The CLI creates the app
and its declared database. Keep your local source for subsequent changes.

Allow the backend origin that `widefleet.jsonc` declares. A one-click install from
the template page allows it, as does `widefleet catalog templates install` with the
CLI's `network:manage` scope. After `widefleet deploy`, run from the app directory:

```sh
widefleet network allow https://personal.connectapi.garmin.com
```

Network changes require the CLI's `network:manage` scope. Wait for the configuration
to activate before connecting accounts.

## Connect a Garmin account

Garmin's Personal API gives Garmin users access to their own data with a key they
create themselves. Garmin's
[Personal API FAQ](https://developer.garmin.com/gc-developer-program/personal/personal-faq/)
describes who it is for: "The Personal API is intended for individual Garmin users
who want programmatic access to their own data. It is not intended for commercial
applications serving multiple end users."

Each user connects their own account:

1. Open the [Personal API Key page](https://connect.garmin.com/app/settings/personalApiToken)
   while signed in to Garmin Connect and select **Create Key**.
2. Accept Garmin's terms and choose when the key expires: after 30, 90 or 180 days,
   or one year. Copy the key; Garmin shows it only once.
3. Open the app URL, paste the key and select **Connect**.

The app checks the key with Garmin, stores it encrypted with the app's Widefleet
keys and never shows it again. Users can also start from Widefleet's connections
page, which they return to once the key is saved.

Garmin emails a reminder about a week before a key expires. Create a new key then
and save it on the app's page; it replaces the old one. A key that expired or was
deleted makes methods return `reconnect_required` until the user saves a new one.
**Disconnect** removes the saved key from the app; deleting the key on Garmin
Connect revokes it.

## Use from another app

From the consuming app's directory, an administrator grants a connection:

```sh
widefleet connect garmin-connect --as GARMIN
```

Replace `garmin-connect` if you chose another name. Call the service while handling
a signed-in user's request so Widefleet forwards the verified caller identity.

Each offered Garmin operation is a method, such as `searchActivities`,
`getDailySleep`, `listDailyHrv` and `downloadActivity`:

```ts
const runs = await env.GARMIN.searchActivities({
  activityType: "running",
  startDate: "2026-11-01",
  endDate: "2026-11-30",
});
if (runs.status === "connected") {
  for (const activity of runs.data) {
    console.log(activity.activityName, activity.distance);
  }
}
```

Dates are calendar dates in the `YYYY-MM-DD` format. Date ranges have the limits
Garmin's descriptions state, such as 28 days for `listDailySteps` and 31 days for
`listDailySleep`. `listActivityTypes` returns the keys that `searchActivities`
filters by. `downloadActivity` returns an activity's original file, such as its FIT
file, as a ZIP archive in `base64`. `connectionStatus` tells whether the user saved
a key Garmin accepts. See `src/api.ts` for every method, its input and Garmin's
description, and `scripts/operations.ts` for the Garmin operation behind each method.

## Results

`connected` holds the `data` Garmin returned, or `null` for a day without data.
`garmin_error` carries the HTTP `status` and the JSON `body` Garmin answered with,
for example for a date range that is too long. `connection_required` and
`reconnect_required` provide a `connectUrl` where the user saves a key.
`authentication_required` means the call has no signed-in user. Retry
`token_failed` after a Garmin outage; respect `retryAfter` for `rate_limited`.
`too_large` means the response is larger than `maximumBytes` (8 MiB): read a shorter
date range. An input that does not match the operation fails before anything is sent.

Garmin's access tokens last 24 hours and have no refresh tokens. The app issues a
token from the saved key when it needs one, reuses it until shortly before it
expires, and issues a new one once when Garmin refuses it.

After connecting, verify an activity listing through the consuming app.

## Update the API

`src/api.ts` and `src/schema.ts` are generated from the OpenAPI description on
Garmin's [Personal API Swagger page](https://developer.garmin.com/gc-developer-program/personal/swagger-docs/)
by the template generator in the Widefleet repository. Garmin publishes the
description inside that page's script; `scripts/openapi.ts` reads it from there
without running the script. To pick up Garmin's changes in your app, or to offer
more operations, run from a checkout of that repository with your app's directory:

```sh
pnpm --filter @platform/template-generator generate /path/to/your/app
```

The generator reads your app's `scripts/operations.ts` and rewrites `src/api.ts`,
`src/schema.ts` and the shared files it copies into `src`, such as `src/rest.ts` and
`src/content.ts`. Keep your own changes out of these files. Garmin's description
gives its operations no IDs, so `scripts/operations.ts` lists each by method and
path, such as `GET /hrv-service/hrv/{calendarDate}`, with its method name. The
generator stops when a listed operation no longer exists. Review the diff before
deploying.
