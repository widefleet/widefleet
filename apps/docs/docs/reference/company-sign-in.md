---
title: Company sign-in settings
description: Configure company sign-in through the CLI or API, manage credentials and check OpenID Connect requirements.
lastModified: 2026-10-27
---

For setup through the browser, follow [Set up company sign-in](/guides/company-sign-in).
This reference covers the same settings for administrators using the CLI or API.
Settings belong to the selected organization and require Owner or Admin permissions.

## Export and apply settings

Sign in with `widefleet login` and [select the organization](/reference/cli-configuration#select-an-organization)
before exporting:

```sh
widefleet settings get
widefleet settings export > settings.json
```

Edit the exported file, preserving unrelated settings. For a first connection,
replace `"sso": null` with the object below, using your provider's values:

```json
{
  "providerId": "example-company",
  "appIdentityType": "oidc",
  "issuer": "https://login.example.com",
  "domain": "example.com",
  "oidcConfig": {
    "clientId": "REPLACE_WITH_CLIENT_ID",
    "clientSecret": "REPLACE_WITH_CLIENT_SECRET",
    "pkce": true,
    "scopes": ["openid", "profile", "email"],
    "mapping": {
      "name": "name",
      "email": "email",
      "extraFields": { "groups": "groups" }
    }
  }
}
```

Choose a `providerId` unique within the installation. Keep it unchanged when
updating an existing connection. Initial setup requires the client secret.
Protect files containing secrets and keep them outside version control.

```sh
widefleet settings plan --file settings.json
widefleet settings apply --file settings.json
widefleet settings domain-verification
```

If the plan requires it, add `--acknowledge-restart` to the apply command.
Publish the returned TXT record in your company's DNS, then verify it:

```sh
widefleet settings verify-domain
```

In the browser, open **Settings → Company sign-in** and use **Test company
sign-in** to verify administrator access. Then require the provider for members:

```sh
widefleet settings activate-sso
widefleet login
```

The new login replaces CLI credentials authorized through email sign-in.
`widefleet account` shows the account's company-link status and browser URL.

A company login grants access within that organization. Selecting another
organization does not extend that login's authority; an organization with a
different company provider requires its own company sign-in.

## Provider values

| `appIdentityType` | `issuer`                                           | App group membership                                                |
| ----------------- | -------------------------------------------------- | ------------------------------------------------------------------- |
| `entra`           | `https://login.microsoftonline.com/TENANT_ID/v2.0` | Microsoft Graph, including nested groups                            |
| `google`          | `https://accounts.google.com`                      | Google Workspace Directory, direct membership only                  |
| `oidc` (default)  | Your provider's issuer URL                         | The ID-token field named by `oidcConfig.mapping.extraFields.groups` |

`domain` is the company email domain, without a URL or wildcard. For Google it
must match the user's Workspace domain. The default name, email and group fields
are `name`, `email` and `groups`; the mapping is shared by workspace and app sign-in.

### Directory credentials

For optional Entra group search, set the exported `directory` field to:

```json
{
  "clientId": "DIRECTORY_APPLICATION_CLIENT_ID",
  "clientSecret": "DIRECTORY_CLIENT_SECRET"
}
```

The registration must be in the same tenant and have the Microsoft Graph
`GroupMember.Read.All` application permission with administrator consent.
App membership checks use the sign-in registration's delegated `User.Read`
permission independently of this search connection.

For Google Workspace, `directory` is required:

```json
{
  "clientId": "directory@PROJECT_ID.iam.gserviceaccount.com",
  "adminEmail": "directory-admin@example.com",
  "clientSecret": "PEM_PRIVATE_KEY"
}
```

Here `clientId` is the service account's email, `adminEmail` is the delegated
Workspace administrator, and `clientSecret` is the RSA private key in PKCS#8 PEM
format. Replace `PEM_PRIVATE_KEY` with the downloaded key file's `private_key`
value, preserving its `\n` escapes in JSON. Complete the
[Google directory setup](/guides/company-sign-in#connect-the-workspace-directory)
before applying it.

Both connections support `widefleet groups search "Finance" --json` and
`GET /api/v1/groups?query=Finance`. Results contain `id`, `name`, `description`,
`source` and a `hasMore` flag. Narrow the query when `hasMore` is true.
API access requires `platform:read`.

## Change credentials or providers

Exports omit `sso.oidcConfig.clientSecret` and `directory.clientSecret`.
Omitting these fields in an update preserves their saved values for the same
provider. Blank secret fields in the browser have the same effect. To rotate a
secret, enter its replacement and save; no platform restart is needed.

Switching between Entra and Google requires new directory credentials. Setting
`directory` to `null` removes the saved connection and secret; Google requires
a directory connection and cannot use that setting.

Rotating only the sign-in client secret preserves domain verification, linked
accounts and app sessions. Other changes to the sign-in configuration can
require users to sign in to apps again.

Changes to the issuer or client identity are rejected while provider accounts
are linked. Before replacing a provider, arrange another usable administrator
login; self-hosted operators can use [administrator recovery](/self-hosting/installation#secrets-and-administrator-recovery).
Removing company SSO explicitly removes its account links. Provider changes
do not themselves revoke existing workspace sessions or CLI refresh grants;
current organization authorization still applies, and API access tokens last
five minutes. Follow [access removal](/guides/members#remove-someones-access)
when offboarding a person.

## OpenID Connect requirements

App sign-in uses `openid profile email` and requests `offline_access`. Enable
refresh tokens for the client. To keep users signed in while updating their
permissions, the provider must return a newly signed ID token with current
identity and group claims on refresh. If it omits that token, users must sign
in again.

For rotating refresh tokens, configure a short reuse window that lets concurrent
browser requests receive the same replacement token. Widefleet's built-in
provider uses 30 seconds. Generic OIDC uses `sub` as the user identifier and the
configured ID-token fields for name, email and groups.

See [membership checks](/reference/app-access#when-membership-changes-take-effect)
for when access changes take effect and what happens during provider outages.

## API and external management

The settings API uses `GET/PUT /api/v1/settings` and
`POST /api/v1/settings/plan`. Domain verification and SSO activation use the
[company sign-in endpoints](/reference/api#members-invitations-and-company-sign-in).

Use `widefleet settings external-management true` or
`PUT /api/v1/settings/external-management` to make the settings UI read-only.
API and CLI changes remain available. An administrator can restore browser
editing with `widefleet settings external-management false`.
