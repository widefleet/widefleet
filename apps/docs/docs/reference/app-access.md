---
title: App access
description: Group rules, permissions, activation and the app access API.
lastModified: 2026-10-23
---

Open an app in management and choose **Access → App access** to select which company
groups may open it. App owners and organization administrators can change these
rules. Management collaborators can inspect them but cannot change them.
Management permissions do not bypass the running app's access rules.

Platform 0.4.0 applies these rules to the app's organization.
Without a company IdP, Widefleet admits verified organization members and supplies no
company group claims; use an empty group list for that mode. With company SSO, the
app IdP registration determines who can authenticate. See [published app sign-in](/guides/members#opening-published-apps)
for session lifetime, membership checks and control-plane availability.

Each original app has one group list shared automatically with all its previews.
A user needs membership in **any one** listed group. An empty
list allows every user admitted by the organization's sign-in configuration; it never
enables anonymous access. Use stable group IDs from the identity provider, one
per line. The optional Entra directory connection enables searching by name.
Generic OIDC installations can enter their configured group claim values directly.
IDs containing commas or control characters are not supported.

Previews inherit the original app's group list and cannot override it, even
when the preview has a different owner. Changes update existing previews as well
as newly created ones. The lists start empty for existing apps during upgrade.
Deleting an original app also requests deletion of all its previews. Their
existing access rules remain in place until the deployment agent removes them.

## CLI

Use the ordinary platform login to manage access from an app project:

```sh
widefleet access
widefleet groups search "Finance"
widefleet access set --group GROUP_ID --group OTHER_GROUP_ID
widefleet access show --app inventory
widefleet access set --all-authenticated
```

`set` replaces the complete list. Every existing and future preview inherits the
same rule automatically. An empty command
is rejected: use `--all-authenticated` to explicitly remove the group restriction
while retaining sign-in. Group IDs and `--all-authenticated` are mutually exclusive.

The app is resolved from `name` in `wrangler.jsonc`, or from `--app NAME_OR_UUID`.
`--config PATH` selects another project file. The CLI reads the current revision
before writing and reports a concurrent edit instead of retrying an overwrite.
Writing on a preview is rejected with a reference to its original app.

Changes wait for the app and its published previews to activate. Apps without a
deployment report `saved` without waiting for publication. `--no-wait` returns
after saving, while activation continues asynchronously. Failed activation on the app or a
preview exits nonzero, as does a newer policy superseding the waiting command.
`show` displays the app's groups, inheritance and each preview's activation status.
`--json` returns the complete API state; redirected output is JSON by default.
The default login scopes `platform:read platform:write` are sufficient, subject
to the same owner or administrator permissions as the management UI.

## Activation and failures

Saving changes stores the desired rules and queues agent work. **Saved · applies from the first deployment**
means that the rules will be used on the first deployment. **Activation pending**
means that a published app is waiting for its new rules. **Active** means that the
agent has confirmed the active runtime revision. The parent page also displays each
preview's activation status. Use **Refresh status** to refresh it.

Rules are applied independently to each hostname, not atomically across all
previews. If a job fails or management is unreachable, the last installed rules
remain in effect. An unconfirmed change may already have reached the runtime;
check the reported error and save the same rules again to reconcile it. Code
deployments and rollbacks always use the current access rules rather than rules
from the old code artifact. Removing all groups is also an explicit, revisioned
change.

The shared runtime checks the groups before forwarding requests to app code or
static assets. User-supplied identity headers are removed, and SSO cookies
and tokens do not reach the app. Internal Cron, Queue and connector invocations
continue to use their existing capability boundaries; they are not browser SSO
requests. Resource-level permissions inside an app remain the app's responsibility.

Group memberships come from the existing SSO session. The current installation
uses a one-hour cookie without refresh, so directory changes take effect at the
next sign-in. An activated policy change applies to subsequent requests in an
existing session. Established connections continue under their earlier authorization.

## API

`GET /api/v1/apps/{appId}/access` returns desired groups, revision,
applied revision, activation state, inheritance and preview status. Management
read authorization is required.

`PATCH /api/v1/apps/{appId}/access` accepts:

```json
{ "groups": ["company-group-id"], "revision": 0 }
```

Change rules on the original app. Supply the revision returned by GET;
concurrent edits return `409` rather than overwriting newer rules. An empty
`groups` array removes the group restriction. Writes require management write
authorization and the original app's owner or an administrator. Preview writes
return `403`.

## Installation and verification

Use matching control-plane, agent and runtime images from the [installation guide](/self-hosting/installation). The standard Compose topology includes app authentication in the shared runtime.

For a custom topology, configure the agent's `PLATFORM_APP_RUNTIME_URL` (default `http://runtime:8080/`) and `PLATFORM_PROXY_URL` (default `https://app-platform-proxy:8443`) as private origins reachable by the relevant services. Preserve the runtime control-key mount from the Compose configuration.

After changing a group rule, wait for **Active** and verify access with an allowed and a disallowed account. If activation fails, check agent, runtime and proxy logs before retrying.
