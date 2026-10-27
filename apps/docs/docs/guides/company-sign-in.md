---
title: Set up company sign-in
description: Connect Microsoft Entra, Google Workspace or another identity provider, then check that colleagues can sign in and open the right apps.
lastModified: 2026-10-27
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
3. In Widefleet, expand **Company directory** and enable **Connect Microsoft Graph**.
4. Enter its **Directory client ID** and **Directory client secret**, then **Save**.

Continue with [verify and activate](#verify-and-activate).

## Google Workspace

You also need a Google Cloud project belonging to your Workspace organization,
permission to create an OAuth client and a service account key, and a Workspace
super administrator who can authorize directory access. Personal Gmail accounts
cannot use this connection.

### Set up Google sign-in

1. In your Google Cloud project, configure **Google Auth platform** with the
   Widefleet app name and support contact. Choose an **Internal** audience for
   your Workspace organization. See Google's [consent setup](https://developers.google.com/workspace/guides/configure-oauth-consent).
2. Under **Clients**, create a **Web application** client. Add both redirect URIs
   from Widefleet under **Authorized redirect URIs**.
3. In Widefleet, select **Google Workspace** under **App identity provider**.
   This fills **Issuer URL** with `https://accounts.google.com`.
4. Enter the OAuth client's **Client ID** and **Client secret**. Set **Company
   email domain** to the Workspace domain your users belong to.

Keep this form open while you connect the directory below. Google Workspace
requires both the sign-in client and the directory connection.

### Connect the Workspace directory

The directory connection lets Widefleet check group membership and lets app
owners find groups by name.

1. In the same Google Cloud project, enable the **Admin SDK API**.
2. Under **IAM & Admin → Service Accounts**, create a service account for
   Widefleet's directory access. Open its **Keys** tab and choose **Add key →
   Create new key → JSON**. Keep the downloaded file private. Google's
   [credential guide](https://developers.google.com/workspace/guides/create-credentials#create_a_service_account_key)
   covers these steps.
3. As a Workspace super administrator, open **Security → Access and data control
   → API controls → Manage Domain Wide Delegation** in the Google Admin console.
   Choose **Add new**, enter the service account's numeric **Client ID** and
   authorize this scope:

   ```text
   https://www.googleapis.com/auth/admin.directory.group.readonly
   ```

   Use the service account's ID here, not the OAuth client from the sign-in step.
   See Google's [domain-wide delegation instructions](https://developers.google.com/identity/protocols/oauth2/service-account#delegatingauthority).

4. Choose a Workspace administrator account with permission to read company
   groups. Widefleet uses that account's permissions for directory reads.
5. In Widefleet, expand **Company directory** and fill in the fields below.
   Choose **Save** when both the sign-in and directory fields are complete.

| Widefleet field                   | What to enter                                                                                     |
| --------------------------------- | ------------------------------------------------------------------------------------------------- |
| Service account email             | The downloaded key file's `client_email` value                                                    |
| Delegated administrator email     | The Workspace administrator chosen in step 4                                                      |
| Service account private key (PEM) | The key file's `private_key` value, including the `BEGIN PRIVATE KEY` and `END PRIVATE KEY` lines |

Paste the private key with real line breaks in place of the JSON file's `\n`
escapes. Do not paste the whole JSON file.

For app access, add people **directly** to the Google groups you plan to use.
For example, if the app allows **Finance**, add the person to Finance itself;
membership in another group nested inside Finance does not grant access.

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
2. Search for the group you want to allow, select it, and choose **Save app rules**.
   If group search is not configured, enter the provider's group ID instead.
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

| What you see                                         | What to do                                                                                                                                                                                                   |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Redirect URI mismatch                                | Copy both redirect URIs from Widefleet again and register them exactly, including the path, on the same provider client.                                                                                     |
| Domain verification fails                            | Check the displayed DNS name and TXT value. Allow the DNS change to propagate, then choose **Verify domain** again.                                                                                          |
| Google rejects directory access                      | Check that Admin SDK is enabled, delegation uses the service account's numeric client ID and the scope above, and the delegated administrator can read groups. New delegation grants may take time to apply. |
| Google rejects the private key when saving           | Paste only the `private_key` value with its header, footer and real line breaks. Use an RSA service account key.                                                                                             |
| Sign-in works, but a colleague cannot open the app   | Check the app's allowed groups and the colleague's membership. For Google, check direct membership. Repeat the test in a fresh browser profile.                                                              |
| Settings are saved, but app sign-in activation fails | Check the activation error in Settings. Ask the installation operator to resolve it, then save again and repeat the app test.                                                                                |

If company sign-in locks you out of a self-hosted installation, use
[administrator recovery](/self-hosting/installation#secrets-and-administrator-recovery).
For credential changes and automated configuration, see the
[company sign-in reference](/reference/company-sign-in).
