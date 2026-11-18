---
title: App access
description: Group rules, permissions, activation and the app access API.
lastModified: 2026-11-18
---

App access rules decide who can open a published app. Set them in management under
**Access → App access**, with `widefleet access` or through the API.

## Who can open an app

A user needs membership in **any one** listed group. An empty list allows every user
admitted by the organization's sign-in configuration; it never enables anonymous access.

- **Widefleet sign-in:** every verified organization member can open the app.
  Widefleet sign-in carries no company groups, so keep the group list empty.
- **Company SSO:** the app IdP registration determines who can authenticate; group
  rules then narrow access further.

See [published app sign-in](/guides/members#opening-published-apps) for the sign-in
experience. The same rules apply to [MCP clients](/guides/mcp): everyone who may
open an app can use its published service methods.

App owners and organization administrators can change the rules. Management
collaborators can inspect them but cannot change them. Management permissions do
not bypass the running app's access rules.

The shared runtime checks the groups before forwarding requests to app code or
static assets. User-supplied identity headers are removed, and SSO cookies
and tokens do not reach the app. Internal Cron, Queue and app service invocations
keep their own capability boundaries; they are not browser SSO requests.
Resource-level permissions inside an app remain the app's responsibility.

## Group identifiers

Enter one group identifier per line. Identifiers containing commas or control
characters are rejected.

| Provider        | Identifier                    | Notes                                                                                                                                                                                                                                  |
| --------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Microsoft Entra | Group object ID               | The optional [directory connection](/guides/company-sign-in#enable-searching-for-groups-by-name) enables searching by name.                                                                                                            |
| Google          | Group's primary email address | An administrator must first [enable group access](/guides/company-sign-in#allow-app-access-by-google-group). Users need direct membership and permission to view the group's membership list. Update the rules if the address changes. |
| Generic OIDC    | Configured group claim value  | See [another OpenID Connect provider](/guides/company-sign-in#another-openid-connect-provider).                                                                                                                                        |

## Previews

Previews always use the original app's group list, even when a preview has a
different owner. Changes apply to existing and new previews. Change the rules on
the original app; writes on a preview are rejected with a reference to it.

Deleting an original app also requests deletion of all its previews. Their
existing access rules remain in place until the deployment agent removes them.

## CLI

Use the ordinary platform login to manage access from an app project:

```sh
widefleet access
widefleet access set --group GROUP_ID --group OTHER_GROUP_ID
widefleet access show --app inventory
widefleet access set --all-authenticated
```

With Entra directory search configured, `widefleet groups search "Finance"`
returns group IDs. For Google, use the group address directly, for example
`widefleet access set --group finance@example.com`.

`set` replaces the complete list. An empty command is rejected: use
`--all-authenticated` to remove the group restriction while retaining sign-in.
Group IDs and `--all-authenticated` are mutually exclusive.

The app is resolved from `name` in `wrangler.jsonc`, or from `--app NAME_OR_UUID`.
`--config PATH` selects another project file. The CLI reads the current revision
before writing and reports a concurrent edit instead of retrying an overwrite.

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
from the old code artifact.

## When membership changes take effect

An activated app access rule applies to subsequent requests, including requests
from people already signed in. Established connections continue under their
earlier authorization.

Changes to a person's directory membership take effect at the next automatic
membership check. The first app request after the provider's access token or
ID token expires triggers that check; the earlier expiry applies. Membership
is rechecked at every token expiry, even though the app session lasts seven days.

| Sign-in method                | Membership checked                                                  | Check interval                                           |
| ----------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------- |
| Widefleet                     | Current organization membership                                     | First request after the five-minute access token expires |
| Microsoft Entra               | Current Graph memberships, including nested groups                  | First request after provider-token expiry                |
| Google Workspace              | Visible direct memberships, when group scope is enabled and granted | First request after provider-token expiry                |
| Other OpenID Connect provider | Groups in the newly verified ID token                               | First request after provider-token expiry                |

Company providers control their token lifetimes and how quickly directory
changes become visible. Allow for both when checking access removal. To verify
new sign-in behavior immediately, use a fresh browser profile; an existing app
login may still have earlier permissions until its next check.

If a required provider check fails temporarily, requests needing that check
receive `503`. The login is retained so the user can retry when the provider
recovers. A user who no longer matches the app's group rules receives `403`.
If the provider requires authentication again, browser requests return to
sign-in.

With company SSO, app sign-in and membership checks contact the provider directly.
A control-plane outage does not prevent those checks. With Widefleet sign-in,
new logins and membership checks need the control plane; previously checked
access remains usable only until the provider token expires.

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

## Verify access

1. Save the group rule and wait for **Active**.
2. Open the app with an allowed account in a fresh browser profile; it loads.
3. Open it with an account outside the listed groups; it receives `403`.

If activation fails, check the reported error and save the rules again. On a
self-hosted installation, an administrator checks the agent, runtime and proxy
logs before retrying; see [logs and troubleshooting](/self-hosting/operations#logs-and-troubleshooting).
