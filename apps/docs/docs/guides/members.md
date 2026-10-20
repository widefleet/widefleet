---
title: Members and company sign-in
description: Accept invitations, manage organization membership and link an optional company account.
lastModified: 2026-10-20
---

Use this flow on an installation with email delivery and organization invitations enabled.
It requires an unreleased build containing organization sign-in and the matching CLI.
An owner or administrator must invite you first; entering an arbitrary email address
does not create access.

## Accept an invitation

1. Open the invitation link and sign in with the email address that received it.
2. Enter the six-digit code from the sign-in email. The code expires after five minutes
   and allows three attempts; request a new code if it expires.
3. Review the organization and role, enter your name when prompted, and accept.

The organization is now available in the workspace. Invitations expire after seven
days. An expired or canceled invitation needs a new invitation from an administrator.
Signing in with a different email does not let you accept it. If company sign-in is
already configured, you can also authenticate through that organization's provider;
the verified email must still match the invitation.

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
Changing an owner to `admin` leaves those invitations pending, including owner invitations;
an owner must cancel any that should no longer be accepted.

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

## Link an optional company account

An organization owner or administrator configures Entra or another OIDC provider in
**Settings → Company sign-in**. Register the displayed management and app callback
URLs and supply the corresponding client credentials. Settings, stored secret
references and optional directory credentials belong to the selected organization.
Use **Settings** or `widefleet settings get`, `plan` and `apply` to inspect and change them.
Directory search queries the configured provider; it does not synchronize users or groups.

After configuration, each existing member opens **Your account** from the account menu
and chooses **Link company account**. This does not require administrator access.
Matching email addresses never silently link accounts. After linking, choose
**Use company sign-in**, or select the organization on the sign-in page next time.
`widefleet account` reports the link status and the browser URL for managing it.

A company sign-in can authenticate only for that company, even if your Widefleet
account has memberships elsewhere. Changing the selected organization cannot widen
that authority. This also applies to CLI credentials and their refresh tokens.
To work across your memberships, use the Widefleet email login when enabled; to use
another company's SSO, sign in through that provider. A browser account switch while
approving a CLI requires reloading the approval page.

## Opening published apps

Without a configured company IdP, the app auth proxy uses Widefleet as its OIDC
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
Changing a provider requires linking and testing the replacement account; configuring
SSO alone does not convert existing accounts or grant memberships.
