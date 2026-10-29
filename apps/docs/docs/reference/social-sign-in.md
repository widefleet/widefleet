---
title: Google and Microsoft sign-in
description: Sign in with a personal provider account and configure providers for an installation.
lastModified: 2026-10-29
---

When an installation enables Google or Microsoft, its sign-in page offers those
buttons alongside the existing email-code form. Microsoft supports both work or
school accounts and personal accounts such as Outlook.com. Registration offers
the same options when public registration is enabled.

## Connect your account

Choose **Continue with Google** or **Continue with Microsoft** and select your
provider account. Use the same email address as your existing Widefleet account
or invitation. When the provider verifies your email, Widefleet connects the account and
continues to your original destination.

If email confirmation is needed, Widefleet asks for a six-digit code. After
confirmation, choose **Connect Google** or **Connect Microsoft** and select the
provider account with that same email address. Once connected, subsequent visits
use the saved provider identity without another email code.

The **Last used** indicator helps you find the method you last used in this
browser. For organizations with required company SSO, use the company provider
shown on their sign-in page. See [members and company sign-in](/guides/members).

## Configure an installation

Configure email-code delivery first so users can complete confirmation when
required. Keep company SSO configured separately in **Settings**.

Create a Google OAuth client for a **Web application**. Register
`PLATFORM_URL/api/auth/callback/widefleet-google` as an authorized redirect URI,
replacing `PLATFORM_URL` with the installation's exact HTTPS origin. Configure
the consent audience to include the intended users. See
[Google client configuration](https://better-auth.com/docs/authentication/google).

Create a Microsoft Entra app registration supporting **Accounts in any
organizational directory and personal Microsoft accounts**. Add a **Web** redirect
URI of `PLATFORM_URL/api/auth/callback/widefleet-microsoft`. Create a client secret
and retain its **value**, rather than its identifier. Widefleet uses Microsoft's
`common` endpoint and requests `openid`, `profile` and `email`. See
[Microsoft provider configuration](https://better-auth.com/docs/authentication/microsoft).

Supply the corresponding credentials to the control-plane process or Worker:

| Provider  | Client ID             | Client secret             |
| --------- | --------------------- | ------------------------- |
| Google    | `GOOGLE_CLIENT_ID`    | `GOOGLE_CLIENT_SECRET`    |
| Microsoft | `MICROSOFT_CLIENT_ID` | `MICROSOFT_CLIENT_SECRET` |

Supply both values for each enabled provider through the installation's secret
store. The Cloudflare deployment command accepts these environment variables.

For Compose, pass the credentials to `control-plane` through a private override:

```yaml
services:
  control-plane:
    environment:
      GOOGLE_CLIENT_ID: ${GOOGLE_CLIENT_ID:-}
      GOOGLE_CLIENT_SECRET: ${GOOGLE_CLIENT_SECRET:-}
      MICROSOFT_CLIENT_ID: ${MICROSOFT_CLIENT_ID:-}
      MICROSOFT_CLIENT_SECRET: ${MICROSOFT_CLIENT_SECRET:-}
```

Recreate the control-plane container with that override or deploy the new Worker
version through the installation's normal deployment process. Visit `/sign-in`:
the configured providers should appear next to the email option.

## Troubleshooting

- **A button is missing:** verify that both credentials reach the running
  control plane. Company-SSO pages show the organization's provider.
- **Redirect URI mismatch:** match the scheme, hostname and complete callback
  path exactly, including `widefleet-google` or `widefleet-microsoft`.
- **Microsoft rejects a personal or work account:** check the app registration's
  supported account types and any consent or access restrictions in that user's
  organization.
- **No email address is shared:** choose an account with an email address or use
  email sign-in.
- **The connection expired:** choose **Confirm email again**, request a new code
  and repeat the connection.
