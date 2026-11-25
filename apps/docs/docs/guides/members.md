---
title: Members and app sign-in
description: Join your organization, open shared apps, invite colleagues and remove access.
lastModified: 2026-11-18
---

Members join an organization with their work account and open the apps shared with
them. Owners and administrators invite people, manage roles and remove access.

## For members

If your company has connected its sign-in provider, you join on your first company
sign-in when that provider allows access. Otherwise, ask an owner or administrator
for an invitation.

### Accept an invitation

1. Open the invitation link and sign in with the email address that received it.
2. Use [Google or Microsoft](/reference/social-sign-in) when offered, or enter the
   six-digit email code. Codes expire after five minutes and allow three attempts.
   If the organization uses company sign-in, accept through that provider.
3. Review the organization and role, then accept.

The organization is now available in your workspace. After repeated failed sign-in
attempts, wait before requesting another code. Invitations expire after 48 hours;
for an expired or canceled invitation, ask an administrator for a new one. Company
sign-in must return the invited email address, and your account's email must be
verified.

With one organization, app commands work without an explicit selection. With
several, use [organization selection](/reference/cli-configuration#select-an-organization).
You can now [deploy an app](/guides/deployments) or open a shared app from the catalog.

### Opening published apps

Open an app from **App catalog** or follow the link a colleague shared with you.
Sign in with your company account when prompted, or with your Widefleet login if
your organization doesn't use company sign-in.

You stay signed in while Widefleet checks in the background that you still have
access. You sign in again after seven days without using an app, after your
company revokes the login, or when your company's sign-in policy requires it.

With Google Workspace, your organization may ask you to allow Widefleet to read
your groups during sign-in. Group-restricted apps need that permission. If you
declined it, sign in again in a fresh browser profile and allow it, or contact your
administrator if Google blocks the request.

App access follows the app's group rules, separately from management permissions.
If access is denied, check that you chose the correct work account, then ask the
app owner whether you belong to an allowed group. Contact your administrator if the
problem continues.

## For owners and administrators

To connect a sign-in provider for the first time, follow
[Set up company sign-in](/guides/company-sign-in).

### Invite and manage members

Use **Members** to invite people, cancel pending invitations, change roles and
remove members. Only owners can grant or change the owner role, and the last owner
can't be removed or demoted. Owner and admin roles in the installation's
`widefleet` organization also grant installation administration; in other
organizations, they grant administration of that organization only.

Each organization supports up to 100 members and 100 pending invitations.
Invitations stay valid until accepted, expired or canceled, even if their inviter
is removed or changes role.

**Invitation saved** means the invitation exists; the email is sent separately. If
it doesn't arrive, check the address and choose **Resend invitation** under
**Pending invitations**. Resending keeps the link and role and renews the 48-hour
expiry. A pending address can only be invited again this way. To change the invited
role, cancel the invitation and create a new one. Operators find email delivery
errors in the control-plane logs.

The same operations are available in the CLI:

```sh
widefleet members list
widefleet invitations invite teammate@example.com --role member
widefleet invitations list
widefleet invitations invite teammate@example.com --role member --resend
```

Use the returned IDs with `widefleet members role MEMBER_ID admin`,
`widefleet members remove MEMBER_ID` or `widefleet invitations cancel INVITATION_ID`.
Recipients can run `widefleet invitations show INVITATION_ID` and
`widefleet invitations accept INVITATION_ID` after signing in with their verified email.

### Roles

| Role   | Permissions                                                                   |
| ------ | ----------------------------------------------------------------------------- |
| Member | Create apps; manage owned apps and apps explicitly shared with them           |
| Admin  | Manage all apps, deployment agents and member roles, except Owner assignments |
| Owner  | Admin permissions plus appointing and changing Owners                         |

People appear under **Members** after their first verified sign-in. Owners and
admins search by name or email there and change roles. Role changes apply to
existing browser and CLI sessions on their next request and persist across
restarts. Published apps have their own [access rules](/reference/app-access).

### Let colleagues manage an app

On an app's **Access** tab, **Management access** lets you search members by name
or email and grant or revoke collaboration. A collaborator can deploy, roll back
and delete that app. Only the app's owner or an administrator can change its
grants, and administrators keep access regardless of grants. The CLI offers the
same with `widefleet grant` and `widefleet revoke`.

All signed-in members see **App catalog**. An app's owner or an administrator lists
it from the app's management page or the CLI; see
[make the app discoverable](/guides/applications#make-the-app-discoverable). Apps
start unlisted, and a listing doesn't grant management or app permissions. The
API uses `GET /api/v1/catalog` and `PUT /api/v1/apps/{appId}/catalog` with
`{ "listed": true }` or `{ "listed": false }`.

### Activate company SSO

Connect Microsoft Entra, Google Workspace or another supported provider. Follow
[Set up company sign-in](/guides/company-sign-in) to register Widefleet, verify your
domain and test access before activating it. For automated configuration, use the
[CLI and API reference](/reference/company-sign-in).

### Remove someone's access

Remove a person under **Members**. How you block future access depends on how the
organization signs in:

- **Widefleet sign-in:** remove their organization membership. They can't start
  another app session, and existing app access ends at the next membership check.
- **Company sign-in:** revoke their access to Widefleet at the company provider,
  then remove their Widefleet membership. Removing only the membership lets a
  person still admitted by the provider join again and open apps.
- **One app only:** remove the person from every group that grants access to that
  app. If the app currently allows all signed-in users, first
  [restrict it to the intended groups](/guides/applications#choose-who-can-open-it).

Cancel any pending invitation as well; removing its sender doesn't cancel it.
Directory changes apply when Widefleet next checks membership and can be delayed by
the company provider. To verify a removal, see
[when membership changes take effect](/reference/app-access#when-membership-changes-take-effect);
a fresh browser profile checks a new sign-in without reusing an existing app login.

To give colleagues access to a new app, continue with
[sharing an app](/guides/applications).
