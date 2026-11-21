---
title: Sign-in and settings
description: Choose how sign-in codes are delivered, automate first setup, connect company sign-in and recover administrator access.
lastModified: 2026-11-18
---

Administrators configure company sign-in, directory search and settings
editability in **Settings**, without restarting the platform. Widefleet stores
these settings in PostgreSQL and generates its authentication, app-cookie and
encryption keys in the persistent `platform-state` volume. This page covers the
operator tasks around them.

## Sign-in codes

`LOGIN_CODE_DELIVERY` in the deployment environment selects how sign-in codes
reach people who sign in with their email address:

- `email`, the default when unset, sends codes by email. It requires an email
  adapter; the standard self-hosted build ships without one.
- `console` prints codes to the control-plane log, as selected in the example
  environment. Read them with
  `docker compose --env-file widefleet-images-0.7.6.env --env-file /absolute/path/deployment.env logs --since=5m control-plane`.
  Anyone who can read these logs can use the codes, so keep them private. Console
  delivery does not confirm that a person controls the inbox; give colleagues
  company sign-in or email delivery instead.

The setting applies to sign-in codes only. Invitation emails also require an
email adapter, and mail failures never fall back to the console. After changing
the setting, recreate the control-plane container; existing sessions stay valid.

If sign-in returns `429`, wait for the delay in the `X-Retry-After` header before
retrying. Users behind a shared proxy share one IP-based request limit.

## Automated first setup

A bootstrap file creates the Owner and optional settings at first start, so the
installation never shows an open setup form.

1. Create the file and keep it and its directory protected on the host. The
   `settings` object is optional, and `owner.organizationName` names the
   organization:

   ```json
   {
     "owner": {
       "name": "IT Administrator",
       "email": "admin@example.com",
       "organizationName": "Example Company"
     },
     "settings": {
       "externallyManaged": false,
       "directory": null,
       "sso": {
         "providerId": "company-widefleet",
         "appIdentityType": "entra",
         "domain": "example.com",
         "issuer": "https://login.microsoftonline.com/00000000-0000-4000-8000-000000000001/v2.0",
         "oidcConfig": {
           "clientId": "COMPANY_CLIENT_ID",
           "clientSecret": "COMPANY_CLIENT_SECRET"
         }
       }
     }
   }
   ```

   Directory credentials, when used, take a `clientSecret` string. Widefleet
   encrypts all secrets before storing them.

2. Create a Compose override that mounts the file read-only into management. The
   file must be readable by the container user:

   ```yaml
   services:
     control-plane:
       environment:
         PLATFORM_BOOTSTRAP_FILE: /run/widefleet/bootstrap.json
       volumes:
         - /absolute/private/bootstrap.json:/run/widefleet/bootstrap.json:ro
   ```

   Never mount the host Docker socket into management.

3. Add the override to `COMPOSE_FILE`. Overrides need the explicit file list, so
   replace `infra/compose.yaml` with its four files:

   ```dotenv
   COMPOSE_FILE=infra/compose.base.yaml:infra/compose.postgres.yaml:infra/compose.s3.yaml:infra/compose.rustfs.yaml:/absolute/private/bootstrap.compose.yaml
   ```

4. [Start the platform](/self-hosting/installation#start-the-platform).

The file initializes the installation once. If initialization fails after the
Owner was created, the next start resumes with that account: keep the file
mounted, correct the reported configuration or provider error and restart.
After initialization succeeds, Widefleet ignores the file and you can remove it;
later changes in Settings persist across restarts. Sign in with an email code or
a [recovery link](#secrets-and-administrator-recovery) to verify the company
domain and test company sign-in.

## Company sign-in

Follow [Set up company sign-in](/guides/company-sign-in) for
[Microsoft Entra](/guides/company-sign-in#microsoft-entra),
[Google Workspace](/guides/company-sign-in#google-workspace) or
[another OpenID Connect provider](/guides/company-sign-in#another-openid-connect-provider).
It covers both redirect URIs, groups for app access,
[group search by name](/guides/company-sign-in#enable-searching-for-groups-by-name),
domain verification and a test with allowed and disallowed accounts. Generic
providers must meet the
[OpenID Connect requirements](/reference/company-sign-in#openid-connect-requirements).

What operators need to know:

- Company sign-in enrolls everyone the provider admits as a Member who can create
  apps, including external guests. Restrict the provider's Widefleet registration
  to the intended users.
- Existing accounts with an email in the verified company domain are linked
  automatically and keep their role. Accounts from other email domains are not
  linked to existing accounts. Existing memberships and pending invitations stay
  as they are.
- Display names that contain non-ASCII characters can arrive empty in apps. Use
  the stable user identifier for authorization.
- Apps keep signing users in while management is unavailable, because the runtime
  keeps the published sign-in configuration and validates logins directly with
  your identity provider. Back up the runtime state that holds these credentials
  with the rest of the [installation](/self-hosting/operations#back-up-and-restore).

**Active** in Settings means apps use the published sign-in configuration. With
email-code sign-in enabled, it can show **Active** while domain verification is
pending, because apps keep using Widefleet sign-in until then. Check domain
verification and SSO enforcement under **Company sign-in**. If activation fails,
check the runtime's health and logs, then save the settings again.

To manage settings as files through the CLI or API, or to make the settings UI
read-only, see the [company sign-in reference](/reference/company-sign-in).

## Secrets and administrator recovery

Widefleet encrypts provider secrets in PostgreSQL with the installation
encryption key. By default it creates `encryption.key` in `platform-state`. To
supply your own key, set either `PLATFORM_ENCRYPTION_KEY` (32 or more characters)
or `PLATFORM_ENCRYPTION_KEY_FILE`, not both. Restoring the database requires the
same key.

Enter and replace provider secrets in Settings or through the settings CLI and
API; the bootstrap file accepts initial values. Saving applies them directly.

If company sign-in locks administrators out, create a recovery link on the host:

1. Run the recovery tool with the email of an existing Owner or Admin:

   ```sh
   docker compose --env-file widefleet-images-0.7.6.env --env-file /absolute/path/deployment.env exec control-plane node tools/recover.ts admin@example.com
   ```

2. Open the printed link in a browser. It works once and opens an administrator
   session for ten minutes. No mail service is needed.
3. Correct the settings, link a replacement company account if needed, and test
   company sign-in.

Recovery sessions are browser-only; they cannot authorize a CLI login.
