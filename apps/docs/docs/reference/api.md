---
title: API and uploads
description: Authentication, app publication and the Worker upload contract.
lastModified: 2026-11-18
---

Authenticated clients can fetch `/api/v1/openapi.json`. The document covers management operations, agent jobs, binary assets and multipart Workers.

Clients must send `Origin: <PLATFORM_URL>` for OAuth form requests and Worker uploads.
Select the organization with the `X-Widefleet-Organization` header; see
[organization context](#organization-context).

## Publish an app

`widefleet deploy` runs this flow. Use the API directly for custom tooling:

1. Resolve or create the configured name with `PUT /api/v1/apps/by-name/{slug}` and body `{}`. The server checks permissions and assigns the deployment host on creation. Names are unique within the selected organization. Use `POST /api/v1/apps` for previews and administrative scripts.
2. Submit an asset manifest to `POST /api/v1/apps/{appId}/assets-upload-session` as `{ "manifest": { "/index.html": { "hash": "HASH", "size": 1234 } } }`. The response contains the session `id`, the app `url`, `expiresAt` and the `missing` hashes.
3. Upload each missing hash with `PUT /api/v1/apps/{appId}/assets/{sessionId}/{hash}` and an `application/octet-stream` body. The API verifies both bytes and declared size.
4. Upload the Worker as multipart data with `PUT /api/v1/apps/{appId}/worker` and a UUID `Idempotency-Key` header. Include one JSON `metadata` field and file parts named after their modules.
5. Follow `GET /api/v1/apps/{appId}/deployments/{deploymentId}/events` and the deployment history at `GET /api/v1/apps/{appId}/deployments` until the deployment reaches `succeeded` or `failed`.

A minimal Worker upload for step 4:

```sh
curl --fail-with-body -X PUT "$PLATFORM_URL/api/v1/apps/$APP_ID/worker" \
  -H "Authorization: Bearer $PLATFORM_ACCESS_TOKEN" \
  -H "Origin: $PLATFORM_URL" \
  -H "X-Widefleet-Organization: $ORGANIZATION_ID" \
  -H "Idempotency-Key: $(uuidgen)" \
  --form-string 'metadata={"main_module":"worker.js","compatibility_date":"2026-10-01","compatibility_flags":["nodejs_compat"],"assets":{"upload_session":"SESSION_ID"}}' \
  -F 'worker.js=@build/worker.js;type=application/javascript+module'
```

The response is the queued deployment, with its `id` and `appId`.

Use the returned `hostname` and `url` as the app's address; they can differ from
the app slug and organization name. Organization hostname suffixes can place apps
and named previews under the shared app domain. See
[preview addresses](/reference/previews#organization-addresses) for naming.
Occupied complete hostnames return `409 CONFLICT`; invalid or overlong hostnames
return `400 BAD_REQUEST` before app creation.

Upload sessions expire after one hour. Repeating an identical publish within its valid session returns the original deployment. A session's Worker content is immutable. Asset hashes follow Wrangler's BLAKE3 algorithm over base64 content plus the case-sensitive file extension; modules use SHA-256. Preview apps have separate identities and artifact prefixes.

Clients that save source before publishing can include
`source: { commit, branch, directory }` in the Worker metadata. The commit must
already exist in the app's managed repository; otherwise the upload returns
`400`. The directory is relative to the repository root (`.` for a root project).
After a rollback, the app's source status identifies the commit used by the
restored version.

Rollback queues a retained code artifact from the same app while preserving its current database and files. Deletion marks the app unwritable and queues teardown after earlier jobs; management records and artifacts are removed after the agent confirms teardown.

See [CLI authentication](/reference/authentication) for credentials, [CLI reference](/reference/cli) for command output, and [runtime](/reference/runtime) for activation and removal behavior.

## Organization context

`GET /api/v1/organizations` lists your available memberships as
`{ id, name, slug, role }` objects. It requires an authenticated session or a
token with `platform:read` and works before an organization is selected.

Send `X-Widefleet-Organization: ORGANIZATION_ID` with API requests, using an ID
from that response. The server checks current membership and role on each
request. Widefleet selects the organization in this order:

1. The `X-Widefleet-Organization` header.
2. The browser session's active organization.
3. On a standard installation, the installation's own organization.
4. The only available organization, when there is exactly one.

Otherwise, requests return `403 ORGANIZATION_REQUIRED`. Widefleet uses only the
organization you select: an invalid or unavailable explicit or saved selection
fails with `403`.

Browser users choose an organization at `/organizations` or follow the organization
name in the workspace header. `PUT /api/v1/organization` accepts
`{ "organizationId": "ORGANIZATION_ID" }` and requires `platform:write` or a
same-origin browser request. For a browser session it saves the active organization;
for a token it validates the selection for that call only, so token clients keep
sending the header on later requests.

The browser selection applies to every tab of that session. If another tab changes
it, writes from a page showing the previous organization are rejected; reload the
page and submit again. Use separate browser sessions to work in two organizations
at once.

### Roles

`GET /api/v1/me` returns the selected context under `application`:
`organizationId` and `admin`. The app service catalog and deployment-agent
discovery are scoped to the selected organization.

| Role                        | `GET /api/v1/me`          | Permissions                                                                  |
| --------------------------- | ------------------------- | ---------------------------------------------------------------------------- |
| App collaborator            | —                         | Inspect the app's connections and manage its secrets.                        |
| Organization Member         | —                         | Create apps.                                                                 |
| Organization Owner or Admin | `application.admin: true` | Manage members, grants between apps, identity settings and directory search. |
| Installation administrator  | top-level `admin: true`   | Manage deployment agents, runtime upgrades and installation reporting.       |

Owners and Admins of the installation's own organization are installation
administrators. See [member management](/guides/members) for owner restrictions.

Settings responses omit directory secrets; omitting `directory.clientSecret` from
an update keeps the saved value.

See [app services](/guides/app-services#api) for discovery, connections and secret endpoints.

Use [CLI organization selection](/reference/cli-configuration#select-an-organization)
for equivalent CLI commands. If a browser selection becomes unavailable, the
workspace returns to organization selection. With no available memberships, ask
an administrator to grant access.

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
no usable company mapping is available. A valid TXT record takes precedence over
the HTTPS document. The endpoint is available on Cloud and returns `400` for an
invalid domain, `503` for malformed or conflicting Widefleet TXT records, and
`404` on other installations.

Authenticate at the returned installation using [CLI login](/reference/authentication).
For publishing discovery records, see [company setup](/self-hosting/company-setup).

## App templates

Template discovery requires an authenticated session or a token with
`platform:read`, together with the selected organization.

`GET /api/v1/catalog/templates` returns `{ templates, createPrompt }`.
Each entry in `templates` contains `id`, `name` and `description`. The optional
`search` query parameter filters names and descriptions
case-insensitively; it accepts up to 200 characters. An unmatched search returns
an empty list. `createPrompt` guides an agent through creating an app for another
use case.

`GET /api/v1/catalog/templates/{templateId}` returns one template with:

- `id`, `name`, `description` and a source URL in `source`.
- `markdown`, the body of the template's `template.md` file.
- `prompt`, a setup prompt containing the installation URL and selected organization.

Templates are read from the [Widefleet repository](https://github.com/widefleet/widefleet/tree/main/templates).
Each directory with a `template.md` is a template; its YAML frontmatter supplies
`name` and `description`, and its directory name supplies `id`. IDs contain
1–64 characters, start with a lowercase ASCII letter, and use only lowercase
ASCII letters, digits and hyphens. Directories with other names are skipped.

An unknown template ID returns `404`; an invalid ID returns `400`. A repository
or template parsing failure returns `503`, as does an exhausted GitHub request
limit; retry after the limit resets. Operators can give the control plane a GitHub
token for higher limits; see [the deployment environment](/self-hosting/installation#create-the-deployment-environment).

See [Use an app template](/guides/app-templates) for the UI and CLI workflow.

## Organization creation

Requires an installation that enables self-service organization creation.

`POST /api/v1/organizations` requires a verified personal account and accepts:

```json
{ "name": "Example Team", "slug": "example-team" }
```

Tokens need `platform:write`; browser sessions require a same-origin request.
Company-scoped credentials are limited to their organization. Names contain
1–200 characters; slugs contain up to 50 lowercase letters, numbers and separating
hyphens.

The response is `{ "id": "...", "name": "Example Team", "slug": "example-team" }`.
Pass the returned ID in `X-Widefleet-Organization` for subsequent requests.

A `409` response explains whether to retry incomplete setup or choose an available
slug. A `403` response means creation is disabled or the account is ineligible.

## Members, invitations and company sign-in

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

Reading or accepting your own invitation works without an existing membership or
organization selection. A company-scoped sign-in accepts invitations for its own
organization. Each invitation can be accepted once before it expires.

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
`POST /api/v1/settings/activate-sso` separately makes company SSO required; it needs
verified DNS, and a completed test login is optional. These operations accept the
same browser or CLI write credentials as settings changes and operate on the selected organization.
See [company sign-in setup](/guides/company-sign-in#verify-and-activate) and the
[settings reference](/reference/company-sign-in) for CLI and API configuration.

## App source repositories

Use these endpoints to find an app's saved code, prepare a repository for a push
and authenticate Git requests. They use the selected organization and require
management access to the app. Token clients need `platform:read` for status and
read credentials, or `platform:write` for preparation and write credentials.
Requests that change state from a browser must come from the same origin.

| Endpoint                                            | Response and purpose                                                                                       |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/apps/{appId}/source`                   | Get the repository, latest saved commit and deployed commit.                                               |
| `POST /api/v1/apps/{appId}/source/prepare`          | Create the repository if needed and return its URL and branch. Body: `{}`.                                 |
| `POST /api/v1/apps/source-target`                   | Check the destination branch before deploying. Body: `{ appId }` or `{ slug }`. Requires `platform:write`. |
| `POST /api/v1/apps/{appId}/source/read-credential`  | Get credentials for cloning and fetching. Body: `{}`.                                                      |
| `POST /api/v1/apps/{appId}/source/write-credential` | Get credentials that also allow pushing. Body: `{}`.                                                       |

Preparation returns `{ organizationId, repository, preview }`. `repository`
contains `{ url, branch, commit }`, or is null when source storage is unavailable
on the installation. `preview` is true for a preview app.

The source-target response is `{ supported, branch, preview }`. It checks the
app without creating an app or repository. A new app selected by `slug` uses
`main`, as do existing main apps. A preview keeps its assigned branch.

### Find saved and deployed code

App lists and reads by ID or name include a `source` summary:

```json
{
  "supported": true,
  "branch": "main",
  "deployed": {
    "commit": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "branch": "main",
    "directory": "apps/inventory"
  }
}
```

`branch` is null for a preview created without a Git branch. `deployed` is null
when the active deployment has no saved source reference; it does not indicate
whether someone has pushed code separately.

To get the latest saved commit as well, use `GET /api/v1/apps/{appId}/source`:

```json
{
  "supported": true,
  "available": true,
  "repository": {
    "url": "https://git.example.com/apps/app-id.git",
    "branch": "main",
    "commit": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  },
  "deployed": {
    "commit": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "branch": "main",
    "directory": "apps/inventory"
  }
}
```

`supported` indicates whether the installation provides repositories. `available`
means the app's branch has a commit. `repository` is null if no repository has
been created; a branch with no commits has `commit: null`. `deployed` identifies
the running app's source. Pushing without deploying updates `repository.commit`
but leaves `deployed` unchanged.

If Git is temporarily unavailable, source status returns `200` with an `error`
message, `available: false` and `repository: null`. Check `error` before treating
the source as empty; the known `deployed` value is still included. Ordinary app
reads return the stored summary without waiting for Git.

### Preview branches

Branches use Git branch-name rules and are limited to 200 characters. Main apps
use `main`. Create a Git preview with `POST /api/v1/apps`, including
`parentId` and `previewBranch`. Its hostname uses a URL-safe name derived from that
branch; if `previewName` is also supplied, it must match the derived name.
The preview shares its parent's repository and keeps the assigned branch through
preparation and deployment. To save source to Widefleet Git, create the preview
with `previewBranch`.

### Git credentials and errors

Credential responses contain `{ url, username, password, expiresAt }` and use
`Cache-Control: no-store`. Use the returned username and password for Git HTTPS
Basic authentication. Cloud credentials expire after five minutes; existing
credentials stay usable until expiry if management access is revoked. Each
new credential request checks current app access. The CLI handles this exchange
through its Git credential helper.

Missing or inaccessible apps return `404`. Credential requests without source
storage return `409`, as does preparing a preview created without a Git branch.
Preparation and credential requests also return `409` while the app is being
deleted. Git failures during preparation or credential requests return `503`.
See [source code](/guides/source-code) for cloning and deletion behavior.

## Database migrations

`POST /api/v1/apps/{appId}/migrations` lists or applies D1 migrations. The body contains
`action` (`list` or `apply`), `database` (binding name), `databaseId` (the configured ID,
or the database name when no ID is configured), `table` and `files`. Each file has a
`name`; `sql` is required for `apply` and omitted for `list`. Send a UUID
`Idempotency-Key` header. Repeating the same request returns the original job; reusing
the key with different content returns a conflict.

Poll `GET /api/v1/apps/{appId}/migrations/{jobId}` for `state`, `message` and `entries`.
A migration job leaves code activation, network grants and app connection permissions
unchanged. Before running, Widefleet checks the app's current binding again, so a queued
migration runs only against the database the binding still identifies.

See [database migrations](/guides/migrations) for file layout, ordering and failure handling.
