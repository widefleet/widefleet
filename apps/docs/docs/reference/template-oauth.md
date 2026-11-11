---
title: Template OAuth
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

Older saved connections require a one-time reconnection after upgrading these
templates. This records which registration issued their tokens.

After switching registrations, users must reconnect. A `reconnect_required` result
includes the connection page URL. Keep the old registration available until its
users have migrated.

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

Omit providers you do not offer. Register these exact callbacks for the providers
you enable:

| Provider  | Callback                                                  |
| --------- | --------------------------------------------------------- |
| Google    | `https://oauth.apps.example.com/oauth/callback/google`    |
| GitHub    | `https://oauth.apps.example.com/oauth/callback/github`    |
| Microsoft | `https://oauth.apps.example.com/oauth/callback/microsoft` |

Google requires a web application registration with Gmail API enabled. Microsoft
uses a web redirect and delegated Graph permissions, with support for the account
types your users need. Provider consent and organization approval requirements
still apply. The template guides list their requested permissions.

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
connection page. If the OAuth registration changes, reconnect each account. A
provider outage during refresh returns `refresh_failed` and preserves the saved
connection so it can be retried.
