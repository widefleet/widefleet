---
name: Garmin Connect
description: Read your own Garmin Connect activities, activity files, sleep, heart rate, HRV, Body Battery and other health data through Garmin's Personal API, with typed results.
---

Read your Garmin Connect activities and their original files, sleep, heart rate,
HRV, Body Battery, stress and other health data from your agents and apps. Each
person connects their own Garmin account with a personal API key.

## Set up

Install the template. Then each person connects their account:

1. Open the [Personal API Key
   page](https://connect.garmin.com/app/settings/personalApiToken) in Garmin
   Connect, select **Create Key**, accept Garmin's terms and choose how long the key
   lasts. Copy the key.
2. Open the app, paste the key and select **Connect**.

Garmin emails a reminder before a key expires. Save a new key on the app's page to
keep the connection.

## Use it

Ask your agent, for example "Compare my HRV and sleep for the last two weeks". To
call it from your own app, connect it from the app's directory:

```sh
widefleet connect garmin-connect --as GARMIN
```

Each Garmin operation is a method, such as `searchActivities`, `getDailySleep`,
`listDailyHrv` and `downloadActivity`. See [using a template
app](https://widefleet.com/docs/guides/app-templates#use-from-agents-and-apps) for
calls, approvals and results.
