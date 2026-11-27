---
title: API and uploads
description: Authentication, app publication and the Worker upload contract.
lastModified: 2026-11-27
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
no usable company mapping is available. A valid TXT record takes precedence over
the HTTPS document. The endpoint is available on Cloud and returns `400` for an
invalid domain, `503` for malformed or conflicting Widefleet TXT records, and
`404` on other installations.

Authenticate at the returned installation using [CLI login](/reference/authentication).
For publishing discovery records, see [company setup](/self-hosting/company-setup).

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
`organizationId` and `admin`. The nested `admin` field authorizes app connection
changes within that organization. The top-level `admin` field remains installation
administration. The app service catalog and deployment-agent discovery are scoped
to the selected organization. App collaborators can inspect their app's connections
and manage its secrets; organization administrators manage grants between apps.
Deployment-agent administration, runtime upgrades and installation reporting still
require installation administration. Identity settings and directory search use the
selected organization's configuration. Organization owners and administrators can
manage that configuration. Directory secrets are encrypted per organization and omitted
from settings responses; omitting `directory.clientSecret` from an update preserves the saved value.

See [app services](/guides/app-services#api) for discovery, connections and secret endpoints.

Use [CLI organization selection](/reference/cli-configuration#select-an-organization)
for equivalent CLI commands. If a browser selection becomes unavailable, the
workspace returns to organization selection. With no available memberships, ask
an administrator to grant access.

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
- `secretHelp`, when provided, maps secret names to Markdown descriptions shown under their inputs during installation.
- `markdown`, the body of the template's `template.md` file.
- `appHost`, the app's host that `markdown` and `secretHelp` name: the installed app's, or the host an install under the template's ID gets.
- `prompt`, a setup prompt containing the installation URL and selected organization.

Templates are read from the [Widefleet repository](https://github.com/widefleet/widefleet/tree/main/templates).
Each directory with a `template.md` is a template; its YAML frontmatter supplies
`name` and `description`, and its directory name supplies `id`. IDs contain
1–64 characters, start with a lowercase ASCII letter, and use only lowercase
ASCII letters, digits and hyphens. Directories with other names are skipped.

To help someone find a required secret, add a description to the frontmatter of
`template.md`. Use the same name as in the Wrangler configuration's
`secrets.required` list. Fields without a description still appear in the form.

```yaml
secretHelp:
  GOOGLE_CLIENT_SECRET: >-
    Open your web application in [Google Cloud OAuth clients](https://console.cloud.google.com/auth/clients)
    and use its client secret.
```

Where a setup step needs the app's address, such as a provider's redirect URI,
write `YOUR-APP-HOST` in `template.md` or `secretHelp`. Widefleet shows the app's
host in its place, so people can register the address before they install:

```markdown
Add `https://YOUR-APP-HOST/auth/callback/google` as an authorized redirect URI.
```

An unknown template ID returns `404`; an invalid ID returns `400`. A repository
or template parsing failure returns `503`. These read operations leave app
creation and configuration to the normal app APIs.

Installation operators can set the optional `GITHUB_TOKEN` on the control plane
to authenticate GitHub directory requests. Public-repository read access is
sufficient. For Compose, add it to the private deployment environment file and
recreate the control-plane service. For Cloudflare, include it in the deployment's
`--control-secrets` file. The token stays on the server.

An unset or empty token uses GitHub's unauthenticated
[request limit](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api).
An exhausted limit or an invalid token makes catalog listing return `503`.
Replace an expired token or wait for the limit to reset before retrying.

See [Use an app template](/guides/app-templates) for the UI and CLI workflow.

## Organization creation

Requires platform **0.4.13 or newer** and an installation that enables
self-service organization creation.

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
the source as empty. The known `deployed` value remains available. Ordinary app
reads return the stored summary without waiting for Git.

### Preview branches

Branches use Git branch-name rules and are limited to 200 characters. Main apps
use `main`. Create a Git preview with `POST /api/v1/apps`, including
`parentId` and `previewBranch`. Its hostname uses a URL-safe name derived from that
branch; if `previewName` is also supplied, it must match the derived name.
The preview shares its parent's repository and keeps the assigned branch.
Neither preparation nor deployment can change it. A preview created without
`previewBranch` cannot save source to Widefleet Git.

### Git credentials and errors

Credential responses contain `{ url, username, password, expiresAt }` and use
`Cache-Control: no-store`. Use the returned username and password for Git HTTPS
Basic authentication. Cloud credentials expire after five minutes; existing
credentials remain usable until expiry if management access is revoked. Each
new credential request checks current app access. The CLI handles this exchange
through its Git credential helper.

Missing or inaccessible apps return `404`. Credential requests without source
storage return `409`, as does preparing a preview created without a Git branch.
Preparation and credential requests also return `409` while the app is being
deleted. Git failures during preparation or credential requests return `503`.
See [source code](/guides/source-code) for cloning and deletion behavior.

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

Clients that save source before publishing can include
`source: { commit, branch, directory }` in the Worker metadata. The commit must
already exist in the app's managed repository; otherwise the upload returns
`400`. The directory is relative to the repository root (`.` for a root project).
After a rollback, the app's source status identifies the commit used by the
restored version.

Rollback queues a retained code artifact from the same app while preserving its current database and files. Deletion marks the app unwritable and queues teardown after earlier jobs; management records and artifacts are removed after the agent confirms teardown.

See [CLI authentication](/reference/authentication) for credentials, [CLI reference](/reference/cli) for command output, and [runtime](/reference/runtime) for activation and removal behavior.
