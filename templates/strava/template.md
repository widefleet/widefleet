---
name: Strava
description: Read activities, streams, routes and segments and create, upload and update activities in Strava, with typed results.
secretHelp:
  STRAVA_CLIENT_ID: >-
    Open your application in [Strava API settings](https://www.strava.com/settings/api) and copy its Client ID.
  STRAVA_CLIENT_SECRET: >-
    Use the Client Secret for the same application in [Strava API settings](https://www.strava.com/settings/api).
---

Read activities, streams, routes and segments and create, upload and update
activities in Strava from your agents and apps. Each person connects their own
Strava account.

## Set up

1. Create an application on [Strava's API settings
   page](https://www.strava.com/settings/api) and set its **Authorization Callback
   Domain** to the app's host name, such as `strava.example.com`. You can set it
   once the app is installed.
2. Enter the application's client ID and secret as `STRAVA_CLIENT_ID` and
   `STRAVA_CLIENT_SECRET` and install the template.

Then open the app and connect your Strava account. A new Strava application connects
its owner's account; to connect more athletes, request a higher athlete capacity
from Strava. The application follows Strava's [API
Agreement](https://www.strava.com/legal/api).

## Use it

Ask your agent, for example "How far did I run this month?". To call it from your
own app, connect it from the app's directory:

```sh
widefleet connect strava --as STRAVA
```

Each Strava operation is a method, such as `listActivities`, `getActivityStreams`
and `createUpload`. See [using a template
app](https://widefleet.com/docs/guides/app-templates#use-from-agents-and-apps) for
calls, approvals and results.
