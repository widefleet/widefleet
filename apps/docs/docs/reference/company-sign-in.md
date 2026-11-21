---
title: Company sign-in settings
description: Configure company sign-in through the CLI or API, manage credentials and check OpenID Connect requirements.
lastModified: 2026-11-18
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

A company login covers its own organization. Each organization with a different
company provider needs its own company sign-in.

## Provider values

| `appIdentityType` | `issuer`                                           | App group membership                                                  |
| ----------------- | -------------------------------------------------- | --------------------------------------------------------------------- |
| `entra`           | `https://login.microsoftonline.com/TENANT_ID/v2.0` | Microsoft Graph, including nested groups                              |
| `google`          | `https://accounts.google.com`                      | Cloud Identity API with optional user consent, direct membership only |
| `oidc` (default)  | Your provider's issuer URL                         | The ID-token field named by `oidcConfig.mapping.extraFields.groups`   |

`domain` is the company email domain, without a URL or wildcard. For Google it
must match the user's Workspace domain. For generic OIDC, the default name, email
and group fields are `name`, `email` and `groups`; its mapping is shared by workspace
and app sign-in. Google app identity uses its standard verified email, name and
subject claims.

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

This Entra connection supports `widefleet groups search "Finance" --json` and
`GET /api/v1/groups?query=Finance`. Results contain `id`, `name`, `description`,
`source` and a `hasMore` flag. Narrow the query when `hasMore` is true.
API access requires `platform:read`.

### Optional Google group access

Set `appIdentityType` to `google`, use `https://accounts.google.com` as the issuer
and leave `directory` as `null`. For sign-in only, use the default scopes:

```json
{ "scopes": ["openid", "profile", "email"] }
```

To check direct group membership, enable Cloud Identity API in the OAuth client's
Google project and add the group scope to `sso.oidcConfig.scopes`:

```json
{
  "scopes": [
    "openid",
    "profile",
    "email",
    "https://www.googleapis.com/auth/cloud-identity.groups.readonly"
  ]
}
```

Complete the [group permission setup](/guides/company-sign-in#allow-app-access-by-google-group)
and use each group's primary email address in app access rules. No directory
credentials are needed. The runtime calls Cloud Identity with the signed-in
user's access token. The user's app identity includes groups only when the scope
is configured and the user grants it.

Direct group memberships returned by Google's
[searchDirectGroups API](https://docs.cloud.google.com/identity/docs/reference/rest/v1/groups.memberships/searchDirectGroups)
grant access. Groups must allow the user to view their membership lists. Enter
group addresses directly through the UI, CLI or app access API.

## Change credentials or providers

Exports omit `sso.oidcConfig.clientSecret` and `directory.clientSecret`. An update
without these fields keeps their saved values for the same provider; blank secret
fields in the browser do the same.

### Rotate a secret

1. Export the settings with `widefleet settings export > settings.json`.
2. Add only the secret you are replacing, such as `sso.oidcConfig.clientSecret`.
3. Run `widefleet settings plan --file settings.json`, then
   `widefleet settings apply --file settings.json`.

The new secret applies without a platform restart. Rotating only the sign-in
client secret keeps domain verification, linked accounts and app sessions.

### Change other settings

Other changes to the sign-in configuration can require users to sign in to apps again.

- **Remove Entra group search:** set `directory` to `null`. This removes the saved
  search connection and its secret. Use `null` when switching to Google or generic OIDC.
- **Add or remove Google's group scope:** users pick up the change at their next
  app sign-in after the configuration is active. Existing app group restrictions
  stay in effect.

### Replace the provider

Widefleet rejects changes to the issuer or client identity while provider
accounts are linked. To move to another provider:

1. Arrange another usable administrator login. Self-hosted operators can use
   [administrator recovery](/self-hosting/sign-in-and-settings#secrets-and-administrator-recovery).
2. Set `"sso": null`, then plan and apply. Removing company SSO also removes its
   account links.
3. Add the new provider object and continue with
   [export and apply settings](#export-and-apply-settings).

Existing workspace sessions and CLI refresh grants stay valid through provider
changes. Every request still checks current organization authorization, and API
access tokens last five minutes. Follow [access removal](/guides/members#remove-someones-access)
when offboarding a person.

## OpenID Connect requirements

App sign-in uses `openid profile email`. Entra and generic OIDC also request
`offline_access`; Google uses `access_type=offline` with consent instead. Enable
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
