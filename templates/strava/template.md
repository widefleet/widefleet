---
name: Strava
description: Read activities, streams, routes and segments and create, upload and update activities in Strava, with typed results.
---

Connect a Strava account and use Strava's API as typed methods: the athlete's
profile, zones and stats, activities with their laps, zones, comments and kudos,
streams, clubs, gear, routes with GPX and TCX exports, segments, segment efforts and
uploads. Each signed-in user connects their own account through the organization's
own Strava API application. Changes ask the user first, as each user's approval level
says.

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

Keep `pnpm-workspace.yaml` and `patches/` with the source. They patch Better Auth to
sign cookies and encrypt saved account tokens with the app's Widefleet keys, which
the app never reads.

## Configure Strava

Each organization registers its own Strava API application. Strava's
[API Agreement](https://www.strava.com/legal/api) and
[API Policy](https://www.strava.com/legal/api_policy) apply to it, including their
rules on AI applications (Policy §5.3) and on showing an athlete's data to other users
(§2.3); the organization that registers the application decides how it uses Strava
data under those terms. An administrator needs to:

1. Create an application on [Strava's API settings page](https://www.strava.com/settings/api).
   Set its **Authorization Callback Domain** to the app's host name, without
   `https://`. The connector's callback is `https://YOUR-APP-HOST/auth/callback/strava`.
2. Set the app secrets `STRAVA_CLIENT_ID` and `STRAVA_CLIENT_SECRET` to the
   application's client ID and client secret. Use the app's Secrets page or
   `widefleet secret put NAME --file /path/to/secret` to provide values.
3. Allow the backend origin that `widefleet.jsonc` declares. A one-click install from
   the template page allows it, as does `widefleet catalog templates install` with the
   CLI's `network:manage` scope. After `widefleet deploy`, run from the app directory:

   ```sh
   widefleet network allow https://www.strava.com
   ```

Network changes require the CLI's `network:manage` scope. Wait for the configuration
to activate, then open the app URL and connect your Strava account. The connector
requests `read`, `read_all`, `profile:read_all`, `profile:write`, `activity:read_all`
and `activity:write`. An athlete who unticks some of them on Strava's consent page is
asked to reconnect.

A new Strava application authorizes only its owner's athlete until Strava raises its
athlete capacity. Strava's default rate limits are 200 requests every 15 minutes and
2,000 a day across the application's athletes, with lower limits for reads; see
[Strava's rate limits](https://developers.strava.com/docs/rate-limits/).

## Use from another app

From the consuming app's directory, an administrator grants a connection:

```sh
widefleet connect strava --as STRAVA
```

Replace `strava` if you chose another name. Call the service while handling a
signed-in user's request so Widefleet forwards the verified caller identity.

Each offered Strava operation is a method, such as `listActivities`, `getActivity`,
`getActivityStreams` and `createActivity`. Inputs and results keep Strava's field
names:

```ts
const recent = await env.STRAVA.listActivities({ after: 1764547200, per_page: 10 });
if (recent.status === "connected") {
  for (const activity of recent.data) {
    console.log(activity.id_str, activity.name, activity.distance);
  }
}
```

Lists take Strava's `page` and `per_page`. IDs are numbers or strings: use the
`id_str` fields of results, since some Strava IDs exceed what a JSON number holds
exactly. `getActivityStreams` takes the stream `keys` and `key_by_type: true`.
`createUpload` sends a FIT, TCX or GPX file as `file`, `{ mimeType, text }` or
`{ mimeType, base64 }` for bytes, with its `data_type`; `getUpload` reports when
Strava has processed it. `exportRouteGpx` and `exportRouteTcx` return the file with
its `contentType`, as `text`, up to 8 MiB. See `src/api.ts` for every method, its
input and Strava's description, and `scripts/operations.ts` for the operation behind
each method.

## Approvals

Reading never asks. Methods that change data ask the user before they run, as their
approval level says:

- `all_changes`: every change asks.
- `updates_and_deletions`, the default: creating and uploading activities, which
  appear in the athlete's followers' feeds unless their visibility says otherwise,
  updating activities and starring segments ask.
- `none`: nothing asks.

`scripts/operations.ts` records whether each method creates, updates, deletes or
sends. Users choose their level on the app's page. `approvalLevel` returns the current
level and `setApprovalLevel` changes it: asking more takes effect at once, asking
less asks the user to confirm.

A method that asks returns `input_required` with the method and its input. MCP
clients show the question to the user. A calling app shows it itself and answers with
`withInput`, as described in
[Ask the user before continuing](https://widefleet.com/docs/guides/app-services#ask-the-user-before-continuing).
A declined change returns `declined` and does not run.

## Results

`connected` holds the `data` Strava returned. `strava_error` carries Strava's
`message`, its `errors` with resource, field and code, and the HTTP `status`, for
example for an unknown activity. A `setup_required` result lists missing secrets.
`connection_required` and `reconnect_required` provide a `connectUrl` for the user;
`permission_required` means the athlete granted fewer scopes than the connector needs
and must reconnect. `authentication_required` means the call has no signed-in user.
Retry `refresh_failed` after a provider outage. `rate_limited` means the
application reached a Strava rate limit; its windows reset every 15 minutes and at
midnight UTC. `too_large` means the response is larger than `maximumBytes` (8 MiB):
read fewer items per page. An input that does not match the operation fails before
anything is sent.

After connecting, verify an activity listing through the consuming app. Users can
disconnect their account on the Strava app's page.

## Update the API

`src/api.ts` and `src/schema.ts` are generated from Strava's published Swagger
description by the template generator in the Widefleet repository. To pick up
Strava's changes in your app, or to offer more operations, run from a checkout of
that repository with your app's directory:

```sh
pnpm --filter @platform/template-generator generate /path/to/your/app
```

The generator reads your app's `scripts/operations.ts`, brings in the schemas
Strava's description keeps in its sibling files, and rewrites `src/api.ts`,
`src/schema.ts` and the shared files it copies into `src`, such as `src/rest.ts` and
`src/approval.ts`. Keep your own changes out of these files. To offer another
operation, add its operation ID with a method name and, unless it only reads with
GET, the kind of change it makes or `read`. The generator stops when a listed
operation no longer exists. Review the diff before deploying.
