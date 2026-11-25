---
title: Members and app sign-in
description: Join your organization, open shared apps, invite colleagues and remove access.
lastModified: 2026-11-22
---

Use your work account to join your organization and open apps shared with you.
If your company has connected its sign-in provider, you can join on your first
company sign-in when that provider allows access. If your organization is open to
your company email domain, you can [join it directly](#join-with-your-company-email).
Otherwise, ask an Owner or Admin for an invitation.

Administrators connecting a provider for the first time should follow
[Set up company sign-in](/guides/company-sign-in).

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

## Join with your company email

Requires platform **0.7.21 or newer** on an installation where people create
their own organizations.

Sign in with your work email. Organizations open to your email domain appear
under **Join your team**, or under **Open to example.com** when you already belong
to an organization. Each shows a colleague from your domain and how many others
belong to it. Choose **Join** to become a member and open the organization. A
check mark beside the name shows that the organization verified the domain for
company sign-in.

The CLI lists and joins the same organizations:

```sh
widefleet organizations joinable
widefleet organizations join ORGANIZATION_ID
```

## Let colleagues join by email domain

Owners and Admins can let everyone with a verified address on the company email
domain join as members, without invitations. Sign in with Google Workspace or a
Microsoft work account on that domain; this sign-in confirms that the domain
belongs to your company.

- When you create an organization, keep **Enable access for example.com** turned on.
- Later, open **Members** and choose **Let anyone with a @example.com address join**
  under **Join by email domain**.

Removing a domain closes it for new members. People who already joined stay
members until you remove them.

```sh
widefleet organizations create --name "Example Team" --slug example-team --allow-domain-join
widefleet settings domain-access
widefleet settings add-join-domain example.com
widefleet settings remove-join-domain example.com
```

### Reserve new organizations for your company

After you [verify your company domain](/guides/company-sign-in), Owners and Admins
can turn on **Reserve new organizations for administrators** under **Members**.
Only your organization's Owners and Admins can then create organizations with
addresses on your verified domains, and only your organization can open itself to
those addresses. Existing organizations continue unchanged.

```sh
widefleet settings restrict-organization-creation true
```

## Opening published apps

Open an app from **App catalog** or follow the link a colleague shared with you.
Sign in with your company account when prompted. If your organization does not
use company SSO, use your Widefleet login.

You stay signed in as you use apps, while Widefleet automatically checks that
you still have access. You may need to sign in again after seven days without
using an app, after your company revokes the login, or when your company's
sign-in policy requires it.

With Google Workspace, your organization may ask you to allow Widefleet to read
your groups during sign-in. That permission is needed for group-restricted apps.
If you declined it, sign in again in a fresh browser profile and allow it, or
contact your administrator if Google blocks the request.

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
