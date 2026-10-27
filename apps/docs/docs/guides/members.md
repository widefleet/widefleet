---
title: Members and app sign-in
description: Join your organization, open shared apps, invite colleagues and remove access.
lastModified: 2026-10-27
---

Use your work account to join your organization and open apps shared with you.
If your company has connected its sign-in provider, you can join on your first
company sign-in when that provider allows access. Otherwise, ask an Owner or
Admin for an invitation.

Administrators connecting a provider for the first time should follow
[Set up company sign-in](/guides/company-sign-in).

## Accept an invitation

1. Open the invitation link and sign in with the email address that received it.
2. Without active company SSO, enter the six-digit code from the sign-in email. It expires
   after five minutes and allows three attempts. With active company SSO, use that
   organization's provider instead; an email-code login cannot accept its invitations.
3. Review the organization and role, then accept.

If repeated sign-in attempts temporarily block access, wait before requesting another code.

The organization is now available in the workspace. Invitations expire after 48
hours. An expired or canceled invitation needs a new invitation from an administrator.
Company SSO must return the invited email, and your account's email must be verified.

With one available organization, app commands work without an explicit selection.
With several, use [organization selection](/reference/cli-configuration#select-an-organization).
You can now [deploy an app](/guides/deployments) or open a shared app from the catalog.

## Opening published apps

Open an app from **App catalog** or follow the link a colleague shared with you.
Sign in with your company account when prompted. If your organization does not
use company SSO, use your Widefleet login.

You stay signed in as you use apps, while Widefleet automatically checks that
you still have access. You may need to sign in again after seven days without
using an app, after your company revokes the login, or when your company's
sign-in policy requires it.

Permission to manage an app does not automatically let you use it. If access is
denied, check that you chose the correct work account, then ask the app owner
whether you belong to an allowed group. If the app is temporarily unavailable
because sign-in cannot be checked, try again later. Contact your administrator
if the problem continues.

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

Owners and administrators can connect Microsoft Entra, Google Workspace or
another supported provider. Follow [Set up company sign-in](/guides/company-sign-in)
to register Widefleet, verify your domain and test access before activating it.
For automated configuration, use the [CLI and API reference](/reference/company-sign-in).

## Remove someone's access

Owners and administrators can remove a person under **Members**. How you block
future access depends on how the organization signs in:

- **Widefleet sign-in:** remove their organization membership. They cannot start
  another app session, and existing app access ends at the next membership check.
- **Company sign-in:** revoke their access to Widefleet at the company provider,
  then remove their Widefleet membership. Removing the membership alone allows
  a person still admitted by the provider to join again and open apps.
- **One app only:** remove the person from every group that grants access to that
  app. If the app currently allows all signed-in users, first
  [restrict it to the intended groups](/guides/applications#choose-who-can-open-it).

Cancel any pending invitation as well; removing its sender does not cancel it.
Directory changes apply when Widefleet next checks membership and can be delayed
by the company provider. See [when membership changes take effect](/reference/app-access#when-membership-changes-take-effect)
when verifying a removal. A fresh browser profile lets you check a new sign-in
without reusing an existing app login.

To give colleagues access to a new app, continue with
[sharing an app](/guides/applications).
