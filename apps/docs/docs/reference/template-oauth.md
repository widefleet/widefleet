---
title: Template OAuth
lastModified: 2026-11-16
---

The Gmail, GitHub and OneDrive templates can use an OAuth registration supplied by
the installation operator. App owners can also provide their own registration.
Each user still connects their own provider account through the template's existing
connection page.

## Choose a registration

| App secrets                                 | Registration used                             |
| ------------------------------------------- | --------------------------------------------- |
| Client ID and client secret both set        | The app owner's registration                  |
| Both absent, managed provider configured    | The installation's registration               |
| Only one set                                | Setup error; complete the pair or remove both |
| Both absent, no managed provider configured | Setup required                                |

The names are `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` for Gmail,
`GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` for GitHub, and `MICROSOFT_CLIENT_ID` /
`MICROSOFT_CLIENT_SECRET` for OneDrive. Use the app's Secrets page or
[`widefleet secret`](/reference/cli) to manage them.

Every template still needs its own persistent `AUTH_SECRET` of at least 32
characters. It encrypts saved account tokens in that app's D1 database. Provider API
requests continue to run in the template, using its existing network policy.

Existing connections keep working after a template upgrade with unchanged custom
credentials. Upgrading does not require a new provider authorization.

To switch between your own and managed credentials, or replace a client ID,
each user must disconnect and connect again. Disconnecting clears the previous
registration's saved tokens. Updating credentials alone does not replace or revoke
existing grants. There is one managed registration per provider; replacing it
does not keep the previous registration available for refresh.

## Configure a managed registration

Hosted Cloudflare installations accept an optional `WIDEFLEET_OAUTH` deployment
secret. Configure provider registrations intended for these templates, separately
from management sign-in credentials.

Choose one HTTPS origin on a single subdomain of the runtime's app domain. For
example, an installation with app domain `apps.example.com` can use
`https://oauth.apps.example.com`. The existing runtime wildcard route serves this
origin. Supply the JSON through your deployment secret store:

```json
{
  "origin": "https://oauth.apps.example.com",
  "providers": {
    "google": {
      "clientId": "YOUR_GOOGLE_CLIENT_ID",
      "clientSecret": "YOUR_GOOGLE_CLIENT_SECRET"
    },
    "github": {
      "clientId": "YOUR_GITHUB_CLIENT_ID",
      "clientSecret": "YOUR_GITHUB_CLIENT_SECRET"
    },
    "microsoft": {
      "clientId": "YOUR_MICROSOFT_CLIENT_ID",
      "clientSecret": "YOUR_MICROSOFT_CLIENT_SECRET"
    }
  }
}
```

The runtime offers three fixed permission profiles: `gmail-readonly` for Gmail,
`github-repo` for repositories and user identity, and `onedrive-read` for OneDrive.
The provider keys in the secret remain `google`, `github` and `microsoft`.
GitHub's `repo` scope includes write permissions, although the template exposes
read methods.

Omit providers you do not offer. Register these exact callbacks for the providers
you enable:

| Provider  | Callback                                                  |
| --------- | --------------------------------------------------------- |
| Google    | `https://oauth.apps.example.com/oauth/callback/google`    |
| GitHub    | `https://oauth.apps.example.com/oauth/callback/github`    |
| Microsoft | `https://oauth.apps.example.com/oauth/callback/microsoft` |

### Create the provider clients

Use the callback from the table above for each managed registration. The provider
links require sign-in; select the project, organization or directory that should
own the registration.

- **Google:** [Enable Gmail API](https://console.cloud.google.com/apis/library/gmail.googleapis.com)
  in the selected project. An existing project can host another OAuth client;
  a new project is not required by this integration. However, clients in one
  project share [branding and consent configuration](https://developers.google.com/identity/siwg/best-practices#google-cloud-project-setup).
  Use a separate project if managed Gmail needs independent branding, audience
  or publishing settings from management sign-in.
  Configure [branding](https://console.cloud.google.com/auth/branding),
  [audience](https://console.cloud.google.com/auth/audience), and
  [data access](https://console.cloud.google.com/auth/scopes). Declare the requested
  `openid`, `email`, `profile` and `https://www.googleapis.com/auth/gmail.readonly`
  scopes. Choose **External** to serve accounts outside the project's organization.
  In [OAuth clients](https://console.cloud.google.com/auth/clients), create a
  **Web application** client with the Google callback above. Save its client ID
  and secret as `providers.google`.
- **GitHub:** Open [New OAuth App](https://github.com/settings/applications/new)
  for a personal registration, or the owning organization's **Settings → Developer
  settings → OAuth apps → New OAuth App**. Use your installation's website as the
  homepage and the GitHub callback above as the authorization callback URL. After
  registration, copy the **Client ID** and select **Generate a new client secret**.
  Save the pair as `providers.github`. Organization access policies still apply.
- **Microsoft:** Open [App registrations](https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade)
  in the owning directory and select **New registration**. Choose **Accounts in any
  organizational directory and personal Microsoft accounts** to support both.
  Under **Authentication**, add the Microsoft callback above as a **Web** redirect.
  Under **API permissions**, add delegated Microsoft Graph `Files.Read` and retain
  `User.Read`. Under **Certificates & secrets**, create a client secret. Save the
  application client ID and the secret's **value**, not its ID, as
  `providers.microsoft`. Tenant consent policies still apply.

### Google testing and public availability

For an external project in **Testing**, add the accounts that will connect under
[Audience → Test users](https://console.cloud.google.com/auth/audience).
[Google limits this mode to 100 test users and expires Gmail authorizations,
including refresh tokens, after seven days](https://support.google.com/cloud/answer/15549945).
Users must authorize again after expiry; this mode is for testing the integration.

Public Gmail access requires more than a client ID and secret. `gmail.readonly`
is a [restricted scope](https://developers.google.com/workspace/gmail/api/auth/scopes).
Unless a documented exception applies, complete Google's restricted-scope
verification before public use. The template reads Gmail through a server, so
Google's [security assessment requirement](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification)
also applies. Verification includes domain ownership and accurate public app and
privacy information. Register the domains used for branding and the callback;
with the example above, the callback's authorized domain is `example.com`.
Changing the publishing status alone does not complete verification.

### Activate and verify

Deploy the runtime configuration and use template versions that support managed
OAuth. Open a template with both provider credential secrets absent, connect a
test account, and verify a read through a consuming app. The provider authorization
request should use the central callback above. An app with its own credentials
continues to use `https://YOUR-APP-URL/auth/callback/PROVIDER`.

An empty `WIDEFLEET_OAUTH` value disables managed registrations on the next hosted
deployment. Apps with their own registrations continue to use them. Other apps
report that setup is required.

## Storage and recovery

The runtime keeps provider client secrets outside customer app code. It checks the
app, organization and signed-in caller during token exchange and refresh. The
central callback returns the user to the originating template; it does not put
access or refresh tokens in a browser URL.

The template stores account tokens locally. Managed refresh tokens carry an
additional encrypted envelope tied to that app, user and registration. Preserve
the runtime's `WIDEFLEET_SECRETS_KEY` as well as each app's database and
`AUTH_SECRET` when backing up an installation.

If consent is cancelled or a callback expires, start again from the template's
connection page. If the OAuth registration changes, disconnect and connect each
account again. A provider outage during refresh returns `refresh_failed` and
preserves the saved connection so it can be retried.
