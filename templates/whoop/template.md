---
name: WHOOP
description: Read WHOOP cycles, recoveries, sleeps, workouts and body measurements, with typed results.
---

Connect a WHOOP membership and use WHOOP's API as typed methods: the member's
profile and body measurements, physiological cycles with their recovery and sleep,
and recoveries, sleeps and workouts. Each signed-in user connects their own
membership through the organization's own WHOOP developer app. Revoking the app's
access asks the user first, as each user's approval level says.

## Deploy

Read the [Widefleet app development guide](https://widefleet.com/docs/guides/app-development)
for CLI setup and authentication. Copy this directory into your project and run:

```sh
pnpm install
pnpm test
widefleet create whoop --name "WHOOP"
widefleet secret put WHOOP_CLIENT_ID --file /path/to/client-id
widefleet secret put WHOOP_CLIENT_SECRET --file /path/to/client-secret
widefleet deploy
```

Choose the app name in `wrangler.jsonc` and create the app with that name. Its
deployments need the WHOOP developer app from [Configure WHOOP](#configure-whoop), which
`wrangler.jsonc` lists as required secrets. The CLI creates the app's declared
database. Keep your local source for subsequent changes.

Keep `pnpm-workspace.yaml` and `patches/` with the source. They patch Better Auth to
sign cookies and encrypt saved account tokens with the app's Widefleet keys, which
the app never reads.

## Configure WHOOP

Each organization registers its own WHOOP developer app, under WHOOP's
[API Terms of Use](https://developer.whoop.com/api-terms-of-use/). An administrator
needs to:

1. Create an app in the [WHOOP Developer Dashboard](https://developer-dashboard.whoop.com/)
   with the scopes `read:profile`, `read:body_measurement`, `read:cycles`,
   `read:recovery`, `read:sleep` and `read:workout`. Add
   `https://YOUR-APP-URL/auth/callback/whoop` as a redirect URL. You can add it once
   the app is installed and its URL is known.
2. Provide the WHOOP app's client ID and client secret as the app secrets
   `WHOOP_CLIENT_ID` and `WHOOP_CLIENT_SECRET`. Installing from the template page asks
   for them; `widefleet catalog templates install` reads them with
   `--secret-file WHOOP_CLIENT_ID=/path/to/client-id --secret-file WHOOP_CLIENT_SECRET=/path/to/client-secret`.
   Change them later on the app's Secrets page or with
   `widefleet secret put NAME --file /path/to/secret`.
3. Allow the backend origin that `widefleet.jsonc` declares. A one-click install from
   the template page allows it, as does `widefleet catalog templates install` with the
   CLI's `network:manage` scope. After `widefleet deploy`, run from the app directory:

   ```sh
   widefleet network allow https://api.prod.whoop.com
   ```

Network changes require the CLI's `network:manage` scope. Wait for the configuration
to activate, then open the app URL and connect your WHOOP account. The connector
requests the six read scopes and `offline`, which keeps the connection through
refreshed tokens. A member connected with fewer scopes is asked to reconnect.

A new WHOOP app can connect up to 10 WHOOP members until WHOOP approves a higher
tier, which the app's owner requests in the Developer Dashboard.

## Use from another app

From the consuming app's directory, an administrator grants a connection:

```sh
widefleet connect whoop --as WHOOP
```

Replace `whoop` if you chose another name. Call the service while handling a
signed-in user's request so Widefleet forwards the verified caller identity.

Each offered WHOOP operation is a method, such as `listCycles`, `getCycleRecovery`,
`listSleeps` and `listWorkouts`. Inputs and results keep WHOOP's field names:

```ts
const cycles = await env.WHOOP.listCycles({ start: "2026-11-01T00:00:00.000Z", limit: 10 });
if (cycles.status === "connected") {
  for (const cycle of cycles.data.records ?? []) {
    console.log(cycle.start, cycle.score?.strain);
  }
}
```

Lists take `start`, `end` and `limit`, and answer with `records` and a `next_token`
while more remain: pass it as `nextToken` to the same method for the next page. Scores
are present when `score_state` is `SCORED`. See `src/api.ts` for every method, its
input and WHOOP's description, and `scripts/operations.ts` for the operation behind
each method.

## Approvals

Reading never asks. `revokeAccess` ends the app's access to the member's WHOOP data;
afterwards WHOOP rejects the saved tokens, and the member reconnects to use the app
again. It asks the user before it runs, as their approval level says:

- `all_changes` and `updates_and_deletions`, the default: `revokeAccess` asks.
- `none`: nothing asks.

Users choose their level on the app's page. `approvalLevel` returns the current level
and `setApprovalLevel` changes it: asking more takes effect at once, asking less asks
the user to confirm.

A method that asks returns `input_required` with the method and its input. MCP
clients show the question to the user. A calling app shows it itself and answers with
`withInput`, as described in
[Ask the user before continuing](https://widefleet.com/docs/guides/app-services#ask-the-user-before-continuing).
A declined change returns `declined` and does not run.

## Results

`connected` holds the `data` WHOOP returned, or `null` for `revokeAccess`.
`whoop_error` carries WHOOP's HTTP `status` and the JSON `body` it sent, if any, for
example 404 for a cycle without a recovery. A `setup_required` result lists missing
secrets. `connection_required` and `reconnect_required` provide a `connectUrl` for
the user; `permission_required` means the member granted fewer scopes than the
connector needs and must reconnect. `authentication_required` means the call has no
signed-in user. Retry `refresh_failed` after a provider outage; respect `retryAfter`
for `rate_limited`. `too_large` means the response is larger than `maximumBytes`
(8 MiB): ask for fewer records. An input that does not match the operation fails
before anything is sent.

After connecting, verify a cycle listing through the consuming app. Users can
disconnect their account on the WHOOP app's page.

## Update the API

`src/api.ts` and `src/schema.ts` are generated from WHOOP's published OpenAPI
description by the template generator in the Widefleet repository. To pick up
WHOOP's changes in your app, or to offer more operations, run from a checkout of that
repository with your app's directory:

```sh
pnpm --filter @platform/template-generator generate /path/to/your/app
```

The generator reads your app's `scripts/operations.ts` and rewrites `src/api.ts`,
`src/schema.ts` and the shared files it copies into `src`, such as `src/rest.ts` and
`src/approval.ts`. Keep your own changes out of these files. To offer another
operation, add its operation ID with a method name and, unless it only reads with
GET, the kind of change it makes or `read`. The generator stops when a listed
operation no longer exists. Review the diff before deploying.
