---
title: API and uploads
description: Authentication, app publication and the Worker upload contract.
lastModified: 2026-10-20
---

Authenticated clients can fetch `/api/v1/openapi.json`. The document covers management operations, agent jobs, binary assets and multipart Workers.

Clients must send `Origin: <PLATFORM_URL>` for OAuth form requests and Worker uploads. SvelteKit's CSRF protection and Better Auth's protections remain enabled.

## Organization context

This section describes unreleased organization-selection behavior and requires
a platform build containing that capability.

`GET /api/v1/organizations` requires an authenticated session or a token with
`platform:read`. It works before an organization is selected and returns only
available memberships as `{ id, name, slug, role }` objects.

For API requests, send `X-Widefleet-Organization: ORGANIZATION_ID` using an ID from
that response. Selection does not grant access: the server checks current
membership and role on each request. The header takes precedence over a browser
session's active organization. Without either, a standard installation uses its
own organization. Otherwise, exactly one available organization is selected
automatically; multiple available organizations require an explicit choice.
With no available organization or no choice among several, requests return
`403 ORGANIZATION_REQUIRED`. An invalid or unavailable explicit or saved selection
fails with `403` and never falls back to another organization.

Browser users choose an organization at `/organizations` or follow the organization
name in the workspace header. `PUT /api/v1/organization` accepts
`{ "organizationId": "ORGANIZATION_ID" }` and requires `platform:write` or a
same-origin browser request. For a browser session it saves the active organization;
for a token it validates the selection for that call without saving a preference.
Token clients must keep sending the header to retain an explicit target on later requests.

The browser choice belongs to the session and is shared by tabs using that session.
Browser writes carry the organization displayed in their workspace. If another tab
changes the session's selection, a stale form or command is rejected before writing.
This also protects forms when the only automatically available organization changes.
Reload the affected page to load the selected organization before submitting the change again.
Use separate browser sessions if you need to work in two organizations concurrently.

`GET /api/v1/me` returns the selected context under `application`:
`organizationId` and `admin`. The nested `admin` field applies to app and connector
administration within that scope. The top-level `admin` field remains installation
administration. Connector catalogs and deployment-agent discovery are scoped to
the selected organization. Connector deployment, updates, secrets, app binding changes,
status and logs require an administrator of the selected organization and stay
within that organization. Same-named connectors in other organizations are independent.
Deployment-agent administration, runtime upgrades and installation reporting still
require installation administration. Identity settings and directory search use the
selected organization's configuration. Organization owners and administrators can
manage that configuration; a stored secret reference from another organization is rejected.

See [connector management](/guides/connectors#manage-connectors-in-an-organization)
for the browser flow and connector API endpoints.

Use [CLI organization selection](/reference/cli-configuration#select-an-organization)
for equivalent CLI commands. If a browser selection becomes unavailable, the
workspace returns to organization selection. With no available memberships, ask
an administrator to grant access.

## Members, invitations and account linking

These endpoints require an unreleased build containing organization invitations.
Reads require `platform:read`, writes require `platform:write`; browser requests use
the same services with session authentication. Administrator operations use the
selected organization and the owner restrictions described in [member management](/guides/members).

| Endpoint                                         | Operation                                                         |
| ------------------------------------------------ | ----------------------------------------------------------------- |
| `GET /api/v1/members?search=&page=1`             | List members; returns `members` and `hasNext`.                    |
| `PATCH /api/v1/members/{memberId}`               | Set `{ "role": "member" }`, `admin` or `owner`.                   |
| `DELETE /api/v1/members/{memberId}`              | Remove a member.                                                  |
| `GET /api/v1/invitations`                        | List invitations for organization administrators.                 |
| `POST /api/v1/invitations`                       | Invite `{ "email": "person@example.com", "role": "member" }`.     |
| `DELETE /api/v1/invitations/{invitationId}`      | Cancel a pending invitation.                                      |
| `GET /api/v1/invitations/{invitationId}`         | Read an invitation addressed to the authenticated verified email. |
| `POST /api/v1/invitations/{invitationId}/accept` | Accept it; body `{}` or `{ "name": "Your Name" }`.                |
| `GET /api/v1/account`                            | Read your company-account link status and browser management URL. |

Reading or accepting your own invitation does not require an existing membership or
organization selection. A company-scoped sign-in cannot accept another organization's
invitation. A global account name can only be changed through a Widefleet email session.
Expired or processed invitations cannot be accepted again. Native Better Auth organization
mutation endpoints are unavailable; use the shared API above.

Company-account linking requires an explicit browser session and provider confirmation
at the returned `accountUrl`. API tokens cannot silently attach an external account.

## Publish an app

1. Resolve or create the configured name with `PUT /api/v1/apps/by-name/{slug}`. The server checks permissions and assigns the deployment host on creation. Names are unique within the selected organization. Explicit `POST /api/v1/apps` remains available for previews and administrative scripts.
2. Submit an asset manifest to `/api/v1/apps/{appId}/assets-upload-session`.
3. Upload each missing hash to the returned session's asset endpoint. The API verifies both bytes and declared size.
4. Upload the Worker as multipart data to `/api/v1/apps/{appId}/worker` with a UUID `Idempotency-Key` header. Include one JSON `metadata` field and file parts named after their modules.
5. Follow the app's deployment history and events from queueing through successful activation by the agent.

Use the returned `hostname` and `url`; do not derive addresses from the app slug or
organization name. Organization hostname suffixes can place apps and named previews
under the shared app domain. See [preview addresses](/reference/previews#organization-addresses)
for naming and required builds. Occupied complete hostnames return `409 CONFLICT`;
invalid or overlong hostnames return `400 BAD_REQUEST` before app creation.

Upload sessions expire after one hour. Repeating an identical publish within its valid session returns the original deployment. A session's Worker content is immutable. Asset hashes follow Wrangler's BLAKE3 algorithm over base64 content plus the case-sensitive file extension; modules use SHA-256. Preview apps have separate identities and artifact prefixes.

Rollback queues a retained code artifact from the same app while preserving its current database and files. Deletion marks the app unwritable and queues teardown after earlier jobs; management records and artifacts are removed after the agent confirms teardown.

See [CLI authentication](/reference/authentication) for credentials, [CLI reference](/reference/cli) for command output, and [runtime](/reference/runtime) for activation and removal behavior.
