---
title: API and uploads
description: Authentication, app publication and the Worker upload contract.
lastModified: 2026-10-23
---

Authenticated clients can fetch `/api/v1/openapi.json`. The document covers management operations, agent jobs, binary assets and multipart Workers.

Clients must send `Origin: <PLATFORM_URL>` for OAuth form requests and Worker uploads.

## Platform discovery before authentication

`GET https://app.widefleet.com/api/platform-discovery?domain=example.com` resolves
the company's public TXT record or HTTPS discovery document. It requires no
credentials and accepts a domain, not a full email address. See
[company discovery](/reference/cli-configuration).

A successful response has the form:

```json
{ "platform_url": "https://platform.example.com" }
```

The result is the published company origin, or `https://app.widefleet.com` when
no usable company mapping is available. Optional website discovery can return
HTML, redirects, errors or no response without blocking Cloud login. DNS failures
also allow the HTTPS check and then the Cloud default. Redirects are never
followed, and private website addresses are not fetched.

The endpoint returns `400` for an invalid domain and `503` for malformed or
conflicting published Widefleet TXT records. It is available on canonical Cloud;
other installations return `404`. Responses are not cached.

The result selects a login destination and grants no access. Obtain device codes
and tokens directly from that destination. Do not send existing tokens to the
discovery endpoint or follow an HTTP redirect to move an authenticated API request.

## Browser discovery for unconfigured CLI clients

Prefer `widefleet login` unless implementing a separate client. Configured clients use
their installation's ordinary device authorization endpoints directly.

1. Call `POST https://app.widefleet.com/api/auth/cli-login/start` without a body.
   Keep the returned `request_id` and `cli_token` in the running process. Show
   `verification_uri` to the user, who enters their email in the browser.
2. Poll Cloud's `POST /api/auth/cli-login/poll` with JSON
   `{ "request_id": "REQUEST", "cli_token": "SECRET" }` at the returned interval.
   `platform_url` is null until the browser selects an installation, then stays fixed.
3. Request a device code directly from that installation's `/api/auth/device/code`,
   with `client_id=platform-cli`, the required scopes and `resource=PLATFORM_URL/api/v1`.
   Retain the secret `device_code` locally and print the public verification link/code.
4. Send only the public `user_code` to Cloud's `POST /api/auth/cli-login/ready`:
   `{ "request_id": "REQUEST", "cli_token": "SECRET", "user_code": "CODE" }`.
   The waiting browser continues to the selected installation's `/device` page.
5. Poll `/api/auth/oauth2/token` directly at the destination using
   `grant_type=urn:ietf:params:oauth:grant-type:device_code`, `client_id=platform-cli`
   and the secret `device_code`. Respect the provider's interval and `slow_down`
   responses. Save tokens and the destination only after successful approval.

The browser ticket and CLI secret are distinct. Cloud stores their hashes, the
selected origin and public approval code for at most 30 minutes. It does not
receive device secrets or self-hosted tokens. Routing is enabled only on Cloud;
start and poll are limited to three starts and 60 polls per minute per client IP.
Responses are not cached. Restarting a terminated command starts a new request.

## Organization context

Organization selection requires platform **0.4.0 or newer**.

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
manage that configuration. Directory secrets are encrypted per organization and omitted
from settings responses; omitting `directory.clientSecret` from an update preserves the saved value.

See [connector management](/guides/connectors#manage-connectors-in-an-organization)
for the browser flow and connector API endpoints.

Use [CLI organization selection](/reference/cli-configuration#select-an-organization)
for equivalent CLI commands. If a browser selection becomes unavailable, the
workspace returns to organization selection. With no available memberships, ask
an administrator to grant access.

## Members, invitations and company sign-in

These endpoints require platform **0.4.0 or newer**.
Reads require `platform:read`, writes require `platform:write`; browser requests use
session authentication. Administrator operations use the
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
| `POST /api/v1/invitations/{invitationId}/accept` | Accept it; body `{}`.                                             |
| `GET /api/v1/account`                            | Read your company-account link status and browser management URL. |

Reading or accepting your own invitation does not require an existing membership or
organization selection. A company-scoped sign-in cannot accept another organization's
invitation. Expired or processed invitations cannot be accepted again.

To resend a pending invitation, use `POST /api/v1/invitations` with its email and role
and `"resend": true`. See [invitation delivery](/guides/members#invite-and-manage-members)
if the email does not arrive.

Company accounts with matching email addresses are linked during verified company SSO.
An active company provider requires SSO authority for organization access; email credentials
receive `403` with code `SSO_REQUIRED`. The organization list includes `ssoRequired` when
the current credential must sign in through that organization's provider.

Organization administrators use `POST /api/v1/settings/domain-verification` to obtain
`{ "name": "_better-auth-token-PROVIDER_ID.example.com", "type": "TXT", "value": "..." }`.
After publishing the record, `POST /api/v1/settings/verify-domain` verifies ownership.
`POST /api/v1/settings/activate-sso` separately makes company SSO required; it requires
verified DNS but does not require a completed test login. These operations accept the
same browser or CLI write credentials as settings changes and operate on the selected organization.
See [activation](/guides/members#activate-company-sso).

## Publish an app

1. Resolve or create the configured name with `PUT /api/v1/apps/by-name/{slug}`. The server checks permissions and assigns the deployment host on creation. Names are unique within the selected organization. Explicit `POST /api/v1/apps` remains available for previews and administrative scripts.
2. Submit an asset manifest to `/api/v1/apps/{appId}/assets-upload-session`.
3. Upload each missing hash to the returned session's asset endpoint. The API verifies both bytes and declared size.
4. Upload the Worker as multipart data to `/api/v1/apps/{appId}/worker` with a UUID `Idempotency-Key` header. Include one JSON `metadata` field and file parts named after their modules.
5. Follow the app's deployment history and events from queueing through successful activation by the agent.

Use the returned `hostname` and `url`; do not derive addresses from the app slug or
organization name. Organization hostname suffixes can place apps and named previews
under the shared app domain. See [preview addresses](/reference/previews#organization-addresses)
for naming and version requirements. Occupied complete hostnames return `409 CONFLICT`;
invalid or overlong hostnames return `400 BAD_REQUEST` before app creation.

Upload sessions expire after one hour. Repeating an identical publish within its valid session returns the original deployment. A session's Worker content is immutable. Asset hashes follow Wrangler's BLAKE3 algorithm over base64 content plus the case-sensitive file extension; modules use SHA-256. Preview apps have separate identities and artifact prefixes.

Rollback queues a retained code artifact from the same app while preserving its current database and files. Deletion marks the app unwritable and queues teardown after earlier jobs; management records and artifacts are removed after the agent confirms teardown.

See [CLI authentication](/reference/authentication) for credentials, [CLI reference](/reference/cli) for command output, and [runtime](/reference/runtime) for activation and removal behavior.
