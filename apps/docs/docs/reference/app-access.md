---
title: App roles and access
description: App roles, administration handover, access rules and gateway activation.
lastModified: 2026-10-23
---

Widefleet assigns a role to a person or company SSO group for a specific app.
Assignments are additive. Group membership comes from company sign-in.

| Role      | Permissions                                                                                                        |
| --------- | ------------------------------------------------------------------------------------------------------------------ |
| User      | Use the published app                                                                                              |
| Developer | User permissions, management details and logs, deployments, rollbacks, database migrations and Workflow management |
| App admin | Developer permissions, role assignments, network grants, catalog listing and deletion                              |

The creator initially receives App admin. People and SSO groups can share that
role with equal permissions; there is no separate app owner. Any app admin can
add or revoke other admins. To hand over administration, grant the new person or
group App admin first, then revoke the previous assignment. Other assignments
remain effective, including access through groups.

At least one admin assignment must remain. If the last admin group's members leave or the group is deleted, a platform
administrator can add a replacement admin before removing the obsolete grant.

Previews inherit roles and app access from the original app. They have
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

Group-based management permissions expire with the company sign-in's ID token.
Sign in through the company provider again to renew them; refreshing the CLI token
alone does not renew group permissions. Personal assignments and administrator
recovery remain available independently.

Configure Entra group claims and the required Graph permissions using
[App group claims](/self-hosting/installation#app-group-claims). A failed or
incomplete group lookup denies the request; check the provider configuration and
permission consent before signing in again.

App SSO retains its configured session lifetime (currently a one-hour cookie
without refresh). Directory membership changes are visible when that session is
renewed.

After a replacement company issuer starts successfully, the control plane creates
new access revisions for apps and previews. Failed SSO activation retains the
previous running configuration and app policies. App permission writes and app
creation wait for the replacement issuer to activate.
Assignments keep their original issuer and do not grant rights in the replacement
directory. A platform administrator can grant roles in the new directory and revoke the old assignments. The
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
widefleet roles grant --group NEW_ADMIN_GROUP_ID --role admin
widefleet roles revoke PREVIOUS_ADMIN_ASSIGNMENT_ID
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

Running apps continue enforcing the last activated permissions while management,
PostgreSQL or the agent is unavailable. Keep the gateway and SSO services available.

Saving permissions and activating them are separate outcomes. `saved` means
first-deployment rules; `pending` means an update awaits confirmation; `active`
means the agent has observed the revision at Traefik. `failed` includes the
activation error. Updates reach app and preview hostnames independently.
A failed or unconfirmed update can already be installed, so its state does not
prove that the preceding revision is still serving.

Revocations take effect at the gateway only when the new rule reaches it. An
isolated gateway retains the previous policy, including its previous grants.
Established connections and operations authorized before a role change may continue. Deployments and rollbacks
always use the current access snapshot, independently of the code version.

App code receives the verified identity without SSO cookies or OAuth tokens.
Business permissions inside an app remain the app's responsibility.

## API

| Endpoint                                                | Operation                                                |
| ------------------------------------------------------- | -------------------------------------------------------- |
| `GET /api/v1/apps/{appId}/roles`                        | Assignments, effective actions, revision and inheritance |
| `GET /api/v1/apps/{appId}/roles/candidates?search=NAME` | Existing member search                                   |
| `POST /api/v1/apps/{appId}/roles`                       | Add a role                                               |
| `DELETE /api/v1/apps/{appId}/roles/{assignmentId}`      | Revoke an assignment; keep at least one admin            |
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

Revocation carries `revision`. Removing the last admin returns `403`; add
a replacement admin first.
An access change contains only `revision` and `allAuthenticated`. Read the
current revision before writing; concurrent edits return `409`.

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
