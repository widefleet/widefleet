---
title: Members and company sign-in
description: Accept invitations, manage organization membership and activate verified company sign-in.
lastModified: 2026-10-21
---

Use this flow on an installation with email delivery and organization invitations enabled.
It requires an unreleased build containing organization sign-in and the matching CLI.
An owner or administrator must invite you first; entering an arbitrary email address
does not create access.

## Accept an invitation

1. Open the invitation link and sign in with the email address that received it.
2. Without active company SSO, enter the six-digit code from the sign-in email. It expires
   after five minutes and allows three attempts. With active company SSO, use that
   organization's provider instead; an email-code login cannot accept its invitations.
3. Review the organization and role, enter your name when prompted, and accept.

Repeated sign-in or code-delivery requests can return HTTP `429`. Wait for the
delay in the response's `X-Retry-After` header before trying again. The three failed
attempts allowed for each email code are checked separately from request limits,
including when requests come from different IP addresses.

The organization is now available in the workspace. Invitations expire after seven
days. An expired or canceled invitation needs a new invitation from an administrator.
Signing in with a different email does not let you accept it. Company SSO must return
the invited email within the verified company domain.

With one available organization, app commands work without an explicit selection.
With several, use [organization selection](/reference/cli-configuration#select-an-organization).
You can now [deploy an app](/guides/deployments) or open a shared app from the catalog.

## Invite and manage members

Owners and administrators use **Members** to invite people, cancel pending invitations,
change roles and remove members. Only owners can grant or change the owner role, and
the last owner cannot be removed or demoted. Owner and admin roles in the installation's
`widefleet` organization also grant installation administration. In other organizations,
these roles grant administration only within that organization.

Removing an inviter or changing their role to `member` cancels their pending invitations.
Changing an owner to `admin` cancels their pending owner invitations; member and admin
invitations remain valid. Only owners can replace an existing owner invitation, including
when inviting that recipient with a lower role.

The same operations are available in the CLI:

```sh
widefleet members list
widefleet invitations invite teammate@example.com --role member
widefleet invitations list
```

Use the IDs returned by these commands for `widefleet members role MEMBER_ID admin`,
`widefleet members remove MEMBER_ID` or `widefleet invitations cancel INVITATION_ID`.
Recipients can use `widefleet invitations show INVITATION_ID` and
`widefleet invitations accept INVITATION_ID --name "Your Name"` after authenticating
with their verified email. These commands require the normal read/write login scopes.

## Activate company SSO

An organization owner or administrator configures Entra or another OIDC provider in
**Settings → Company sign-in**. Enter the company email domain, register the displayed
management and app callback URLs, and supply separate client credentials. Save, choose
**Get verification record**, publish the displayed DNS TXT record, then choose
**Verify domain and sign in**. DNS ownership is checked by Better Auth's SSO plugin.
Until verification succeeds, the provider cannot authenticate users and an email-enabled
organization continues using Widefleet sign-in.

Once verified, company SSO is required for this organization in the browser, API and
CLI. Existing email sessions and email-authorized CLI tokens no longer grant access to
it. Sign in through the company provider and authorize the CLI again. Existing accounts
with the same company email are linked automatically; membership and role are preserved.
Addresses outside the verified domain are rejected. An existing account with a different
email is not merged. Hosted users still need a membership or invitation.

Settings, encrypted provider credentials and optional directory credentials belong to the
selected organization. Directory search queries the configured provider; it does not
synchronize users or groups. The equivalent CLI flow is:

```sh
widefleet settings get
widefleet settings export > settings.json
# Edit identity.domain, provider and client credentials in settings.json.
widefleet settings plan --file settings.json
widefleet settings apply --file settings.json
widefleet settings domain-verification
# Publish the returned TXT name/value in the company's DNS.
widefleet settings verify-domain
```

If the plan requires it, pass `--acknowledge-restart` when applying settings. After
verification, open the organization's company login in the browser and run `widefleet login`
to obtain new CLI credentials. `widefleet account` reports account status and its browser URL.

A company sign-in authenticates only for that company, even if the account has memberships
elsewhere. Changing the selected organization cannot widen that authority, including
through CLI refresh tokens. An email login can access memberships without active SSO;
other companies with SSO require their own provider. A browser account switch while
approving a CLI requires reloading the approval page.

Replacing the provider, company domain or management client ID requires a new domain proof.
It removes the old provider account links, ends company browser sessions and deletes their
CLI refresh grants; issued API access tokens expire within five minutes. Other organizations'
sessions remain intact. Rotating only the management client secret preserves domain proof
and account links. Test the new login before completing self-hosted setup. The installation
operator can use the [recovery procedure](/self-hosting/installation#secrets-and-administrator-recovery).

## Opening published apps

Without active, domain-verified company SSO, the app auth proxy uses Widefleet as its OIDC
provider. New app logins require the control plane; an existing one-hour app session
continues to work while the control plane is unavailable. Current organization
membership is checked when a new app session is issued.

With company SSO, the proxy authenticates directly at that IdP using the published
organization configuration. The control plane is needed to change configuration,
but is not in the app login path. Both modes validate app sessions in the runtime,
and an organization's session cannot authorize another organization's apps.

App [access rules](/reference/app-access) remain separate from management roles.
Without company group claims, leave group restrictions empty: that allows the
organization members admitted by Widefleet, never anonymous visitors. With company
SSO, an empty group list allows users admitted by the app's IdP registration; restrict
that registration to the intended users. Nonempty rules require matching group claims.
Changes to organization membership or to users and groups at the IdP do not immediately
revoke an already issued app cookie; new sessions reflect them at the next sign-in,
within the one-hour session lifetime. Changing the provider configuration or app client ID
in Widefleet invalidates existing app sessions as soon as the new configuration is active.
Rotating only the IdP client secret preserves existing sessions.

If settings are saved but app sign-in is unavailable, check their activation status
and the displayed callback registration. Retry publication after resolving the error.
If DNS verification fails, check the exact TXT name and value, allow DNS propagation,
and retry verification. Saving provider credentials alone does not activate SSO or grant membership.
