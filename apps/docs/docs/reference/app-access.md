---
title: App roles, ownership and access
description: App roles, ownership transfer, access rules and gateway activation.
---

Widefleet assigns a role to a person or company SSO group for a specific app.
Assignments are additive. Group membership comes from company sign-in; Widefleet
does not maintain a separate team directory.

| Role      | Permissions                                                                                                        |
| --------- | ------------------------------------------------------------------------------------------------------------------ |
| User      | Use the published app                                                                                              |
| Developer | User permissions, management details and logs, deployments, rollbacks, database migrations and Workflow management |
| App admin | Developer permissions, role assignments, network grants, catalog listing and deletion                              |
| Owner     | App admin permissions and ownership transfer                                                                       |

Every original app has exactly one owner, initially its creator. The owner can
be a person or a group. The current owner or a platform administrator can
transfer ownership directly, without recipient acceptance. The previous owner
loses the owner role; other personal or group assignments remain. Ordinary role
writes cannot create, duplicate or remove an owner. Concurrent writes use the
same revision and return `409` when another change wins.

Previews inherit roles, ownership and app access from the original app. They have
no independent role assignments. Network and connector grants retain their own
rules; those permissions are not copied from the parent. Platform administrators
retain management and recovery access without automatically obtaining access to
a running app. Connector deployment and enterprise connector grants remain
platform administrator operations. Catalog visibility alone grants no access.

## Identities and company sign-in

People and groups use stable IDs scoped to their identity provider. Entra uses
the tenant issuer and object IDs, so renaming a person or group does not change
permissions. Recreating a deleted group does not recover its old permissions.
Generic OIDC uses the configured `subjectClaim` (default `sub`). Configure a
claim that identifies the same person in both management and app SSO clients;
client-specific pairwise subjects need a shared immutable claim. Never use email
addresses as a substitute for that identity mapping.

The UI can search existing members and, with the optional directory connection,
Entra groups. Stable provider IDs can also be entered directly. Installation
members without a verified company account use the `widefleet` namespace for
management permissions; those local identities cannot authenticate at app SSO.

Management reads group claims from the provider ID token stored by Better Auth
after verified sign-in. The issuer's token expiry bounds those group permissions.
A Widefleet session or CLI token refresh does not extend that deadline. Company
sign-in renews the claims, and the identity provider decides whether this requires
user interaction. Personal assignments and platform recovery do not depend on a
group snapshot. Entra group overage is resolved using delegated `User.Read` and
Microsoft Graph's `/me/transitiveMemberOf`, including transitive group IDs.
In-flight requests and results are shared for the same verified token; app role
changes do not repeat the lookup. Results cannot outlive that ID token. A complete
lookup is bounded to 20 pages and ten seconds; failed or incomplete lookups deny
the request rather than return partial permissions. Both Entra registrations need
their group claims configured; the management registration also requests `User.Read`.

App SSO retains its configured session lifetime (currently a one-hour cookie
without refresh). Directory membership changes are visible when that session is
renewed. No additional fixed hourly management reauthentication policy is imposed.

After a replacement company issuer starts successfully, the control plane creates
new access revisions for apps and previews. Failed SSO activation retains the
previous running configuration and app policies. App permission writes and app
creation wait for the replacement issuer to activate.
Assignments keep their original issuer and do not grant rights in the replacement
directory. A platform administrator can reassign ownership and roles there. The
explicit all-authenticated switch remains enabled where selected. Once projected,
gateway status stays pending until the agent confirms the replacement rules.

## CLI

```sh
widefleet roles show
widefleet roles search 'Engineering'
widefleet groups search 'Engineering'
widefleet roles grant --group GROUP_ID --role developer
widefleet roles grant --person PERSON_ID --role user
widefleet roles revoke ASSIGNMENT_ID
widefleet roles transfer --group NEW_OWNER_GROUP_ID
widefleet roles transfer --person NEW_OWNER_PERSON_ID
widefleet access show
widefleet access set --all-authenticated true
widefleet access set --all-authenticated false
```

Commands resolve the app from the project's `wrangler.jsonc`, or accept
`--app NAME_OR_UUID` and `--config PATH`. `roles search` returns the precise
principal reference: use `--person` for a company subject or `--member` for an
internal `widefleet` member ID. Redirected output is JSON; `--json` also selects
JSON explicitly. Role changes save management permissions immediately. Use
`widefleet access` to inspect gateway activation after a role change.

`access set` waits for the app and published previews to activate unless
`--no-wait` is supplied. Failed activation or a superseding revision exits
nonzero. Unpublished apps report `saved` without waiting for a first deployment.
The normal management token scopes remain a ceiling over app permissions;
network changes additionally require `network:manage`.

## Independent gateway and activation

New apps have a closed audience. All app roles include `app:use`. Access for
every authenticated company user is a separate explicit switch; empty person
and group lists never open access. Anonymous access is never enabled.

The control plane derives a revisioned access snapshot from app roles and the
explicit audience switch. The agent persists it in each app's Traefik route.
The local authorizer runs in the existing SSO container and compares verified
OAuth2 Proxy identities against that snapshot. It has no control-plane or
database connection. The agent can stop, or management and PostgreSQL can be
unreachable, while the last installed rules continue protecting running apps.
The SSO container and its persisted configuration must remain available.

Saving permissions and activating them are separate outcomes. `saved` means
first-deployment rules; `pending` means an update awaits confirmation; `active`
means the agent has observed the revision at Traefik. `failed` includes the
activation error. Updates reach app and preview hostnames independently.
A failed or unconfirmed update can already be installed, so its state does not
prove that the preceding revision is still serving.

Revocations take effect at the gateway only when the new rule reaches it. An
isolated gateway retains the previous policy, including its previous grants.
Established connections and already delivered data cannot be recalled. Queued
operations authorized before a role change may finish. Deployments and rollbacks
always use the current access snapshot, independently of the code version.

Incoming identity headers are stripped. Only the verified SSO service supplies
identity; SSO cookies and OAuth tokens do not reach app code. Internal cron,
queue and connector calls retain their existing capability boundaries. Business
permissions inside an app remain the app's responsibility. Deployment approvals
belong in the company's Git/CI workflow.

## API

| Endpoint                                                | Operation                                                |
| ------------------------------------------------------- | -------------------------------------------------------- |
| `GET /api/v1/apps/{appId}/roles`                        | Assignments, effective actions, revision and inheritance |
| `GET /api/v1/apps/{appId}/roles/candidates?search=NAME` | Existing member search                                   |
| `POST /api/v1/apps/{appId}/roles`                       | Add a non-owner role                                     |
| `DELETE /api/v1/apps/{appId}/roles/{assignmentId}`      | Revoke a non-owner assignment                            |
| `PUT /api/v1/apps/{appId}/owner`                        | Transfer ownership                                       |
| `GET /api/v1/apps/{appId}/access`                       | Desired rules and activation for app and previews        |
| `PATCH /api/v1/apps/{appId}/access`                     | Set explicit all-authenticated access                    |

A role grant body contains `principal`, `role` and `revision`:

```json
{
  "principal": {
    "type": "group",
    "provider": "https://login.microsoftonline.com/TENANT_ID/v2.0",
    "subject": "GROUP_ID"
  },
  "role": "developer",
  "revision": 1
}
```

Transfer uses the same body without `role`. Revocation carries `revision`.
An access change contains only `revision` and `allAuthenticated`. Read the
current revision before writing; conflicts are never retried as overwrites.
UI remote functions and HTTP handlers call the same authorization services.

## Installation

The unreleased role model replaces personal ownership and the old creator grants.
It requires an installation without existing apps; the schema update refuses to
silently discard existing permissions. Upgrade the control plane, SSO container,
agent and CLI together. Agents advertise access-rule protocol version 2;
older agents cannot process protected app jobs.

The standard SSO image now exposes its private authorizer on port 4181 alongside
OAuth2 Proxy on 4180. `PLATFORM_APP_AUTH_URL` defaults to
`http://oauth2-proxy:4181/`; custom topologies must route it to the local
authorizer. `PLATFORM_PROXY_URL` remains the agent's private HTTPS verification
origin. No public authorizer port or additional production service is needed.
