---
title: Set up company sign-in
description: Connect Microsoft Entra, Google Workspace or another identity provider, then check that colleagues can sign in and open the right apps.
lastModified: 2026-11-18
---

Connect your company's login so colleagues can use their work accounts for
Widefleet and its apps. You configure the connection once for your organization.

You need an Owner or Admin account in Widefleet, access to your identity
provider's administration console, and permission to add a DNS record for your
company email domain. Have a published app and two test accounts ready: one
that should be allowed to open it and one that should not.

## Start in Widefleet

1. Select the organization you want to configure and open **Settings → Company sign-in**.
2. Choose **Configure company SSO** if no connection exists yet.
3. Enter your **Company email domain**, such as `example.com`.
4. Copy the **Workspace redirect URI** and **App redirect URI**. Your provider
   needs both so people can sign in to Widefleet and open published apps.
5. Complete the section for [Microsoft Entra](#microsoft-entra),
   [Google Workspace](#google-workspace) or [another OpenID Connect provider](#another-openid-connect-provider).

If the settings are read-only, your organization manages them externally. Use
the [CLI or settings API](/reference/company-sign-in) through that process.

## Microsoft Entra

### Register Widefleet

1. In the Microsoft Entra admin center, open **App registrations → New registration**.
   Name it **Widefleet** and select accounts in your organizational directory.
2. Add a **Web** platform under **Authentication**. Add both redirect URIs copied
   from Widefleet to the same registration.
3. Under **Certificates & secrets**, create a client secret. Keep its **Value**
   for the next step; the secret's ID is not the value Widefleet needs.
4. Under **API permissions**, ensure Microsoft Graph's delegated **User.Read**
   permission is present. Grant consent according to your tenant's policy.
5. In Widefleet, choose **Microsoft Entra** under **App identity provider**.
   Fill in the following fields, then choose **Save**.

| Widefleet field | Value from Entra                                                                                         |
| --------------- | -------------------------------------------------------------------------------------------------------- |
| Issuer URL      | `https://login.microsoftonline.com/TENANT_ID/v2.0`, replacing `TENANT_ID` with the Directory (tenant) ID |
| Client ID       | Application (client) ID                                                                                  |
| Client secret   | The secret's Value                                                                                       |

Widefleet reads group memberships from Entra, including membership through
nested groups. You do not need to add a groups claim under Token configuration.
See Microsoft's [registration guide](https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app)
and [membership permissions](https://learn.microsoft.com/en-us/graph/api/user-list-transitivememberof?view=graph-rest-1.0)
for provider-side details.

### Choose who may sign in

In **Enterprise applications**, open the Widefleet application. To limit access
to selected colleagues, require user assignment and assign the intended users
under **Users and groups**, including your administrator test account. Follow
Microsoft's [assignment guide](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/assign-user-or-group-access-portal).

People admitted by this application can join your Widefleet organization as
Members. You will choose who may open each published app separately.

### Enable searching for groups by name

This is optional. Without it, app owners can enter group IDs from Entra when
setting app access.

1. Choose an app registration in the same tenant; you can use the Widefleet
   registration above. Add Microsoft Graph's **GroupMember.Read.All** application
   permission and grant administrator consent.
2. Create a client secret for that registration.
3. In Widefleet, expand **Directory search** and enable **Connect Microsoft Graph**.
4. Enter its **Directory client ID** and **Directory client secret**, then **Save**.

Continue with [verify and activate](#verify-and-activate).

## Google Workspace

You need a Google Cloud project belonging to your Workspace organization and
permission to create an OAuth client. Colleagues sign in with accounts from your
Workspace organization; personal Gmail accounts are not part of this connection.

### Set up Google sign-in

1. In your Google Cloud project, configure **Google Auth platform** with the
   Widefleet app name and support contact. Choose an **Internal** audience for
   your Workspace organization. See Google's [consent setup](https://developers.google.com/workspace/guides/configure-oauth-consent).
2. Under **Clients**, create a **Web application** client. Add both redirect URIs
   from Widefleet under **Authorized redirect URIs**.
3. In Widefleet, select **Google Workspace** under **App identity provider**.
   This fills **Issuer URL** with `https://accounts.google.com`.
4. Enter the OAuth client's **Client ID** and **Client secret**. Set **Company
   email domain** to the Workspace domain your users belong to. Keep **OAuth
   scopes** at `openid profile email` for sign-in only.
5. Choose **Save**. If all signed-in colleagues should be able to open your apps,
   continue with [verify and activate](#verify-and-activate).

### Allow app access by Google group

Complete this optional step when you want to restrict an app to particular groups.
You need permission to enable an API in your Google Cloud project and to change
the relevant groups' settings. No service account or private key is needed.

1. In the OAuth client's Google Cloud project, enable the **Cloud Identity API**
   under **APIs & Services → Library**.
2. In **Google Auth platform → Data Access**, add this scope to the app's requested
   permissions:

   ```text
   https://www.googleapis.com/auth/cloud-identity.groups.readonly
   ```

3. In Widefleet, add the same scope to **OAuth scopes**, separated from the existing
   scopes by a space. Choose **Save**. Existing app users will sign in again after
   the updated configuration becomes active.
4. In Google Groups, open each group you want to use. Under **Group settings →
   Who can view members**, allow **Group members** to view the membership list.
   If you cannot change that setting, ask a group owner or Workspace administrator.
   See Google's [group permissions guide](https://support.google.com/groups/answer/2464975).
5. Add the intended users **directly** to that group and copy its primary email
   address, such as `finance@example.com`. You will enter that address in the
   app's allowed groups.

At sign-in, users may be asked to allow Widefleet to read their Google groups.
If your organization blocks that request, a Workspace administrator needs to
approve the OAuth app and scope under its API access policy. A user who declines
the group permission can still sign in and use apps open to all signed-in users,
but cannot open group-restricted apps.

Widefleet checks the user's direct memberships in groups whose membership list the
user may view; membership through a nested group is not included. For example, if
the app allows Finance, add the person to Finance itself and allow Finance members
to view its membership list.

Continue with [verify and activate](#verify-and-activate).

## Another OpenID Connect provider

1. Register Widefleet as a web client with your provider. Add both redirect URIs
   shown in Widefleet and allow the `openid`, `profile`, `email` and
   `offline_access` scopes.
2. Enable refresh tokens so people can stay signed in. Check the
   [provider requirements](/reference/company-sign-in#openid-connect-requirements)
   with your identity administrator.
3. In Widefleet, select **OpenID Connect** under **App identity provider**.
   Enter the provider's issuer URL, client ID and client secret.
4. To restrict apps by group, configure the provider to include groups in ID
   tokens. Under **Claim mappings → App groups**, enter that field's name;
   the default is `groups`. Adjust **Name** and **Email** only if your provider
   uses different fields.
5. Choose **Save**, then continue below.

## Verify and activate

1. Choose **Get verification record**. Add the displayed TXT record to your
   company domain's DNS, then choose **Verify domain**.
2. Choose **Test company sign-in**. Use the company account with the same email
   as your Widefleet administrator account.
3. Check that Widefleet reports **Company sign-in and administrator access
   verified successfully**. Resolve any error before continuing.
4. Choose **Activate company SSO**. Check that the page reports **Company SSO is
   required for this organization** and that app sign-in activation succeeds.

Members must now use the company provider for this organization. Existing
accounts with matching verified company email addresses keep their memberships
and roles. Colleagues who use the CLI need to run `widefleet login` again.

## Check app access

1. Open a published app in Widefleet and choose **Access → App access**.
2. For Google Workspace, enter the group's primary email address, one per line.
   For Entra, search for the group or enter its object ID. For another provider,
   enter the value it supplies in its group claim. Choose **Save app rules**.
3. Wait for **Active**. Open the app's launch URL in a separate browser profile
   using an allowed test account. It should open after company sign-in.
4. Use another browser profile for an account outside the allowed groups.
   It should be denied access to the app.

Leaving the group list empty allows everyone admitted by the organization's
sign-in configuration. Selecting several groups allows members of any one of them.
These rules also apply to the app's previews.

Setup is complete when company sign-in works and both access checks produce the
expected result. Next, [share the app with colleagues](/guides/applications).

## If setup fails

| What you see                                         | What to do                                                                                                                                                                                      |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Redirect URI mismatch                                | Copy both redirect URIs from Widefleet again and register them exactly, including the path, on the same provider client.                                                                        |
| Domain verification fails                            | Check the displayed DNS name and TXT value. Allow the DNS change to propagate, then choose **Verify domain** again.                                                                             |
| Google group access is unavailable                   | Check that Cloud Identity API is enabled in the OAuth client's project, the group scope is configured, and your organization permits it.                                                        |
| Google sign-in works, but group access is denied     | Check the group's primary email address, direct membership and **Who can view members** setting. If the user declined group permission, repeat sign-in in a fresh browser profile and allow it. |
| Sign-in works, but a colleague cannot open the app   | Check the app's allowed groups and the colleague's membership. Repeat the test in a fresh browser profile.                                                                                      |
| Settings are saved, but app sign-in activation fails | Check the activation error in Settings. Ask the installation operator to resolve it, then save again and repeat the app test.                                                                   |

If company sign-in locks you out of a self-hosted installation, use
[administrator recovery](/self-hosting/sign-in-and-settings#secrets-and-administrator-recovery).
For credential changes and automated configuration, see the
[company sign-in reference](/reference/company-sign-in).
