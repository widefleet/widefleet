---
title: Members and company sign-in
description: Accept invitations, manage organization membership and activate verified company sign-in.
lastModified: 2026-10-29
---

Use this flow on an installation with email delivery and organization invitations enabled.
Use platform and CLI **0.4.0 or newer**.
Without company SSO, an owner or administrator must invite you first. With verified company SSO, users
admitted by that provider can join as members on their first sign-in without an invitation.

## Accept an invitation

1. Open the invitation link and sign in with the email address that received it.
2. Use [Google or Microsoft](/reference/social-sign-in) when offered, or enter the
   six-digit email code. Codes expire after five minutes and allow three attempts.
   With active company SSO, use that
   organization's provider instead; an email-code login cannot accept its invitations.
3. Review the organization and role, then accept.

If repeated sign-in attempts temporarily block access, wait before requesting another code.

The organization is now available in the workspace. Invitations expire after 48
hours. An expired or canceled invitation needs a new invitation from an administrator.
Company SSO must return the invited email, and your account's email must be verified.

With one available organization, app commands work without an explicit selection.
With several, use [organization selection](/reference/cli-configuration#select-an-organization).
You can now [deploy an app](/guides/deployments) or open a shared app from the catalog.

## Invite and manage members

Owners and administrators use **Members** to invite people, cancel pending invitations,
change roles and remove members. Only owners can grant or change the owner role, and
the last owner cannot be removed or demoted. Owner and admin roles in the installation's
`widefleet` organization also grant installation administration. In other organizations,
these roles grant administration only within that organization.

Existing invitations stay valid after their inviter is removed or changes role, until
accepted, expired or explicitly canceled. Inviting the same address again without choosing
**Resend invitation** returns an error. Resending a pending invitation keeps its link and
assigned role and renews its 48-hour expiry. To change the invited role, cancel the invitation
and create a replacement. Each organization supports up to 100 members and 100 pending invitations.

**Invitation saved** confirms that the invitation exists, not that its email was delivered.
If the email does not arrive, check the address and choose **Resend invitation** under
**Pending invitations**. Delivery errors are recorded in the control-plane logs; the pending
invitation remains available for another send attempt.

The same operations are available in the CLI:

```sh
widefleet members list
widefleet invitations invite teammate@example.com --role member
widefleet invitations list
widefleet invitations invite teammate@example.com --role member --resend
```

Use the IDs returned by these commands for `widefleet members role MEMBER_ID admin`,
`widefleet members remove MEMBER_ID` or `widefleet invitations cancel INVITATION_ID`.
Recipients can use `widefleet invitations show INVITATION_ID` and
`widefleet invitations accept INVITATION_ID` after authenticating
with their verified email. These commands require the normal read/write login scopes.

## Activate company SSO

An organization owner or administrator configures Entra or another OIDC provider in
**Settings → Company sign-in**. Enter the company email domain, register the displayed
workspace and app callback URLs in one IdP registration, and enter its client ID and secret once. Save, choose
**Get verification record**, publish the displayed DNS TXT record, then choose
**Verify domain**.
Until verification succeeds, the provider cannot authenticate users and an email-enabled
organization continues using Widefleet sign-in.

After verification, **Test company sign-in** optionally checks the connection. Email
access remains available until an administrator chooses **Activate company SSO**.
Activation makes company SSO required for this
organization in the browser, API and CLI. Existing email sessions and email-authorized CLI tokens no longer grant access to
it. Sign in through the company provider and authorize the CLI again. Existing verified
accounts with matching company email addresses can link automatically; existing membership and role are preserved.

Users admitted by the provider, including guests with another email domain, join as
members without a separate invitation. An existing pending invitation retains its
acceptance flow and invited role. An external email claim alone does not link an
existing account. Removing a member is not a permanent SSO access block: a subsequent
provider-authorized login can add them again. To block future SSO access, remove their
assignment to Widefleet at the company provider.

Settings, encrypted provider credentials and optional directory credentials belong to the
selected organization. Directory search queries the configured provider. The equivalent CLI flow is:

```sh
widefleet settings get
widefleet settings export > settings.json
```

For the first connection, the export contains `"sso": null`. Replace that `null`
with the following object, adapting the domain, issuer and client credentials to your
provider. Choose a `providerId` unique within the Widefleet installation and keep it
unchanged when updating the connection. Leave the other exported settings intact.

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

`appIdentityType` selects the app identity format: `oidc` by default, or `entra` for Microsoft object IDs and group handling. For OIDC, `oidcConfig.mapping.extraFields.groups` names the provider claim containing app groups; change it if your provider uses a name such as `roles`. Both workspace and app sign-in use the same saved provider mapping.

The initial registration requires the client secret. Then plan and apply the edited file:

```sh
widefleet settings plan --file settings.json
widefleet settings apply --file settings.json
widefleet settings domain-verification
# Publish the returned TXT name/value in the company's DNS.
widefleet settings verify-domain
# Optionally test company sign-in in the browser, then enforce it.
widefleet settings activate-sso
```

If the plan requires it, pass `--acknowledge-restart` when applying settings. After
activation, open the organization's company login in the browser and run `widefleet login`
to obtain new CLI credentials. `widefleet account` reports account status and its browser URL.

A company sign-in authenticates only for that company, even if the account has memberships
elsewhere. Changing the selected organization cannot widen that authority, including
through CLI refresh tokens. An email login can access memberships without active SSO;
other companies with SSO require their own provider.

The settings export includes the editable provider fields but omits its secret; applying that export
preserves the saved secret. Set `sso.oidcConfig.clientSecret` to rotate it. The UI likewise
keeps the saved secret when the field is blank. Directory credentials remain independent of company login credentials. Set
`directory` to `{"clientId":"CLIENT_ID","clientSecret":"CLIENT_SECRET"}` when
configuring Entra directory search. Exports omit `directory.clientSecret`; leaving it
out of an update preserves the organization's encrypted secret. Supply a new value
to rotate it, or set `directory` to `null` to remove the directory configuration and secret.

Changes to the issuer or client identity are rejected while provider accounts are linked. Removing
company SSO explicitly removes its provider account links. Provider updates and removal
do not automatically revoke existing control-plane sessions or CLI refresh grants;
current organization authorization still applies, and access tokens last five minutes.
A self-hosted installation requires another usable login before removal. Rotating only
the secret preserves domain proof and account links. The installation operator can use
the [recovery procedure](/self-hosting/installation#secrets-and-administrator-recovery).

## Opening published apps

Without active, domain-verified company SSO, the app auth proxy uses Widefleet as its OIDC
provider. New app logins require the control plane; an existing one-hour app session
continues to work while the control plane is unavailable. Current organization
membership is checked when a new app session is issued.

With company SSO, the proxy authenticates directly at that IdP using the published
organization configuration. The control plane is needed to change configuration,
but is not in the app login path.

App [access rules](/reference/app-access) remain separate from management roles.
Without company group claims, leave group restrictions empty: that allows the
organization members admitted by Widefleet, never anonymous visitors. With company
SSO, an empty group list allows users admitted by the app's IdP registration; restrict
that registration to the intended users. Nonempty rules require matching group claims.

With Widefleet app sign-in, removing a member prevents new app sessions. With company
SSO, revoke the user's app access at the IdP or remove them from the groups required
by the app's access rules. Removing their Widefleet membership alone does not block
direct company app login.

These membership and IdP changes do not revoke an already issued app cookie; it remains
valid until its one-hour lifetime ends. The next app sign-in checks Widefleet membership
or the current IdP admission and group claims, according to the configured login mode.
Changing the provider configuration or shared client ID in Widefleet invalidates existing
app sessions as soon as the new configuration is active.
Rotating only the IdP client secret preserves existing sessions.

If settings are saved but app sign-in is unavailable, check their activation status
and the displayed callback registration. Retry publication after resolving the error.
If DNS verification fails, check the exact TXT name and value, allow DNS propagation,
and retry verification.
