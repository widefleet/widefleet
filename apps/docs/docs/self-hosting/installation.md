---
title: Single-host installation
description: Install, configure and recover a company installation.
lastModified: 2026-10-29
---

This guide installs Widefleet **0.4.13** using the reference Compose deployment. Use Linux x86-64, Docker Engine 29.8.1, Docker Compose 2.20.0 or newer (including v5), and a checkout of the matching release. Published images contain the required runtime and setup tools; the operator host needs no Node, pnpm or Rust installation. The operator owns DNS, certificates, identity-provider registrations, backups and upgrades. Commands below change the selected installation; choose its environment file deliberately.

This page describes local PostgreSQL, RustFS and operator-provided certificates. [External services and automatic HTTPS](/self-hosting/external-services) use the same maintained base configuration with selectable service files.

Docker 29.8.1 is the tested host baseline, pinned in CI. Its network address allocation supports the fleet's fixed app addresses; see the [29.x release notes](https://docs.docker.com/engine/release-notes/29/#2904).

## Infrastructure and first start

Copy `infra/deployment.env.example` to a private file outside version control. Set the database/storage credentials, `PLATFORM_URL`, `APP_DOMAIN` and the absolute `PLATFORM_DATA_DIRECTORY`. The management hostname must be outside the app domain, for example `platform.example.test` and `*.apps.example.test`. Configure DNS and provide `${PLATFORM_DATA_DIRECTORY}/tls/fullchain.pem` and `privkey.pem`, or select [automatic HTTPS](/self-hosting/external-services#automatic-https-with-cloudflare).

Configure company SSO, directory credentials and browser editability in **Settings**; these are stored in PostgreSQL. Widefleet generates its authentication, app-cookie and encryption keys in the persistent `platform-state` volume. Preserve that volume across deployments.

**Keep first setup accessible only to the installing administrator**, or supply the [bootstrap file](#automated-first-setup) before exposing the installation. The first person who completes the setup form becomes Owner; there is no initial shared password or setup key. Once claimed, this endpoint cannot create another administrator.

For interactive first setup, choose a sign-in-code transport before starting the containers:

- `LOGIN_CODE_DELIVERY=email` is the default. It requires a configured email adapter; the standard self-hosted build does not include a mail service.
- `LOGIN_CODE_DELIVERY=console` explicitly prints sign-in codes to the control-plane log. The example deployment environment selects this operator mode. Read it with `docker compose ... logs --since=5m control-plane`. Log readers can use the codes, so keep logs private. Console delivery does not prove control of the email inbox. Use email delivery or company SSO for ordinary users.

This setting controls sign-in codes only. Invitations still require an email adapter. Mail failures never switch delivery to the console. Changing the transport requires recreating the control-plane container and does not revoke existing sessions.

Open `PLATFORM_URL`:

Enter the organization name and create the first administrator with a name and email, then request a sign-in code. Read it from the selected transport and sign in. Codes expire after five minutes and allow three incorrect attempts.
After sign-in, **Publish your first app** shows CLI connection and deployment commands. Before deploying, [connect an agent](#start-services).

To configure company SSO:

1. Open **Organization settings**, enter the issuer URL and choose the app identity claims: Microsoft Entra for Entra object IDs and group handling, or OpenID Connect for standard subjects and configurable group claims. The page shows both callback URLs before saving.
2. Register both callbacks in one IdP registration and enter its client ID and secret once. Enable directory search only if needed.
3. Enter your company email domain and publish the DNS TXT record shown by **Get verification record**. Choose **Verify domain**, then **Test company sign-in** and authenticate with the same email as the first administrator. Widefleet links that account automatically and checks its administrator access.
4. Choose **Activate company SSO**. Company SSO becomes required for the operator organization. Existing email-code sessions can no longer access it; the operator recovery command remains available. An email-code login cannot bypass required SSO.

The standard installation has one organization. Colleagues join through invitations or company SSO.

Customer administrators can change their own SSO and directory settings without restarting the platform.

Company sign-in automatically enrolls users admitted by the organization's provider as Members who can create apps, including external guests. Restrict the shared IdP registration to the intended users. Existing memberships keep their roles, and pending invitations retain their acceptance flow. Without company SSO, customers join through invitations. Apps enforce their own access rules and business permissions using the verified user and group context.

Existing accounts with a matching email in the verified company domain are linked automatically, retaining their membership and role. External guests admitted by the provider can join, but a different email domain does not establish trusted linking to an existing account. See [company SSO activation](/guides/members#activate-company-sso) for CLI commands and provider replacement behavior.

Known runtime limitation: celld `0.6.2` drops incoming header values containing non-ASCII bytes. Display names can therefore be empty in Workers; the stable user identifier remains available for authorization.

If sign-in returns `429`, wait for the delay in the `X-Retry-After` header before retrying.
Users behind a shared proxy share an IP-based request limit.

### Automated first setup

Mount a JSON file read-only into the control-plane container and set `PLATFORM_BOOTSTRAP_FILE` to its container path. The file must be readable by the container user. Keep it and its parent directory protected on the host.

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

`owner.organizationName` optionally names the installation organization. `settings` is optional. SSO credentials belong to the native provider configuration; directory credentials, when used, accept a `clientSecret` string. Both are encrypted before storage. A Compose override can mount the bootstrap file; it must not mount the host Docker socket into management.

For example, add this override to the selected Compose files (the source paths must already exist):

```yaml
services:
  control-plane:
    environment:
      PLATFORM_BOOTSTRAP_FILE: /run/widefleet/bootstrap.json
    volumes:
      - /absolute/private/bootstrap.json:/run/widefleet/bootstrap.json:ro
```

The bootstrap file initializes the administrator and the optional settings once. If initialization fails after creating the administrator, the next start resumes with that account. Keep the file mounted, correct the reported configuration or provider failure, and restart until initialization succeeds. After successful initialization, the file is ignored and can be removed; later UI/API changes survive restarts. Use an email-code login or a recovery link to complete DNS verification and test the company login.

### UI, API and CLI configuration

```sh
widefleet settings get
widefleet settings export > settings.json
widefleet settings plan --file settings.json
widefleet settings apply --file settings.json
# Only when the plan reports a restart:
widefleet settings apply --file settings.json --acknowledge-restart
widefleet settings external-management true
widefleet settings external-management false
```

The CLI and external integrations use `GET/PUT /api/v1/settings`, `POST /api/v1/settings/plan` and `PUT /api/v1/settings/external-management`. Administrator permission is required for UI, API and CLI changes. Exports omit the SSO secret; leaving it out of an update preserves the saved value. Set `sso.oidcConfig.clientSecret` to replace it. Directory exports omit `clientSecret`; leaving it out of an update preserves the selected organization's saved secret. Stored secret values are never returned.

External management makes the settings UI read-only; API/CLI writes and app management remain available. An administrator can turn browser editing back on.

Settings are validated before saving. The shared runtime applies app sign-in configuration
without restarting. Activation status describes the published app sign-in configuration.
With email-code sign-in enabled, it can be active while company-domain verification is
pending because apps still use Widefleet sign-in. Check DNS verification and SSO enforcement
separately under company sign-in. If
publication fails, correct the runtime connection and save again.

The app runtime keeps the published authentication configuration and validates company
logins directly with the IdP. Company app sign-in does not contact the control plane or its
PostgreSQL database. Protect and back up the runtime state containing those credentials.

### Secrets and administrator recovery

Entered provider secrets are encrypted in PostgreSQL. `PLATFORM_ENCRYPTION_KEY` or `PLATFORM_ENCRYPTION_KEY_FILE` can supply an operator-managed key; otherwise Widefleet creates `encryption.key` in `platform-state`. Use one source. The database and the same key are both required for restoration.

Enter and replace provider secrets through Settings or the settings API/CLI. The one-time bootstrap accepts initial values too. Saving applies the change directly.

If company SSO is broken, run on the selected installation's host:

```sh
docker compose ... exec control-plane node tools/recover.ts admin@example.com
```

The command requires an existing Owner or Admin and prints a one-use link. It opens a fixed ten-minute administrator session; it does not create a permanent login credential. The token travels in the URL fragment, not a request URL. Recovery sessions cannot authorize a CLI credential. Correct the settings, link a replacement company account if needed, and verify company sign-in. No mail service is needed.

### App group claims

**Enable group claims on the app-SSO registration before using group-based permissions in apps.** Widefleet forwards the group claims configured in Entra. Follow these steps to include them in app sign-ins:

1. In the Microsoft Entra admin center, open **App registrations** and select the shared Widefleet registration.
2. Open **Token configuration → Add groups claim** and select the group types the apps need. For security-group permissions, select **Security groups** (`groupMembershipClaims: "SecurityGroup"`).
3. Configure the **ID token** to emit **Group ID** in the `groups` claim. Keep object IDs rather than group names and do not select **Emit groups as role claims**: the runtime reads `groups`.
4. After a new app-SSO sign-in, verify that an intended group member receives the expected IDs in server-side `locals.user.groups`. The app implements its own authorization using these IDs. An app's management collaboration grants do not configure these claims.

Entra limits JWT group claims to **200 group memberships per user**, including nested groups. Above that limit, it omits the entire group list and provides an overage indicator for a Microsoft Graph lookup; it does not return the first 200 groups. The app runtime's Entra integration resolves that indicator, including all result pages. Grant the app-SSO registration the delegated **User.Read** permission and consent to it. A failed overage lookup fails the login. Missing group claims without an overage indicator still become `locals.user.groups = []`, so an empty array does not establish that the user has no directory memberships. App authorization must require the expected group explicitly rather than grant access when the list is empty.

For large directories, **Groups assigned to the application** can restrict the emitted set to relevant groups assigned to the app-SSO enterprise application. This mode includes direct memberships only; nested memberships are not included. Choose it only if that matches the apps' permission model.

`groupMembershipClaims` is a Microsoft application-registration setting, not an OpenID Connect standard field. The resulting token claim is named `groups`. See Microsoft's [group-claim configuration and limits](https://learn.microsoft.com/en-us/entra/identity/hybrid/connect/how-to-connect-fed-group-claims) and [optional claims setup](https://learn.microsoft.com/en-us/entra/identity-platform/optional-claims).

### Generic OIDC

Choose **OpenID Connect** app identity claims in Settings, enter the issuer URL, then register both displayed callback URLs on the same client. Management requests `openid profile email` and verifies ID tokens. Changing the issuer or client identity while accounts are linked is rejected by the native SSO plugin.

For apps, configure the IdP to include memberships in the ID token. The optional token fields select group, name and email claims; defaults are `groups`, `name` and `email`. The verified user identifier is `sub`. Generic OIDC uses the groups supplied in the token. Each app implements its own authorization.

### Optional group search

For Entra, enable **Connect Microsoft Graph** in Settings to let authenticated app builders search company groups through `widefleet groups search "Einkauf" --json` or `GET /api/v1/groups?query=Einkauf`. API tokens require `platform:read`; the CLI uses the normal Widefleet login. Results contain the native group `id`, `name`, existing `description` and `source`, plus `hasMore` when the search should be narrowed. Graph is queried directly; no directory database or SCIM setup is required.

Grant the directory registration Microsoft Graph **GroupMember.Read.All application permission**, with tenant admin consent. Enter the directory client ID and secret for a registration in the same tenant. Omitting `directory.clientSecret` from an API update preserves the saved encrypted secret. This application permission is separate from the app-SSO registration's delegated `User.Read` permission for group overage. See Microsoft's [list groups API and permissions](https://learn.microsoft.com/en-us/graph/api/group-list?view=graph-rest-1.0).

Search returns Entra object IDs, matching app tokens configured to emit Group ID. Choosing a group during development does not grant access to the app; its server-side code checks `locals.user.groups`. Directory credentials stay in the control plane. A directory outage makes search unavailable but does not affect app authentication, which uses the published runtime configuration and IdP.

## Pull the release images

Release 0.4.13 provides three public Linux amd64 images on Docker Hub. Pulling them does not require a registry login:

| Image                               | Purpose                                                |
| ----------------------------------- | ------------------------------------------------------ |
| `docker.io/widefleet/control-plane` | Management UI, API and installation initialization     |
| `docker.io/widefleet/agent`         | Deployment agent and matching celld publish executable |
| `docker.io/widefleet/runtime`       | Shared celld runtime, including app sign-in            |

All three images and the bundled app runtime use version `0.4.13`. Installation pins container images by digest using the release manifest.

Open [release v0.4.13](https://github.com/widefleet/widefleet/releases/tag/v0.4.13) and download `widefleet-images-0.4.13.env` and `widefleet-images-0.4.13.env.sha256` into the repository root. Select the matching configuration and verify the manifest:

```sh
git checkout v0.4.13
sha256sum --check widefleet-images-0.4.13.env.sha256
docker compose --env-file widefleet-images-0.4.13.env --env-file /absolute/path/deployment.env -f infra/compose.yaml --profile agent pull
```

Keep the image manifest with the private deployment environment and supply both files to Compose. The pull includes the three Widefleet images and the PostgreSQL, RustFS and Traefik dependencies. Compose starts the `runtime` service directly; app sign-in runs inside it.

## Start services

Create the data directory and its `objects`, `agent`, `postgres` and `tls` subdirectories. Authentication keys, edge configuration, runtime configuration and runtime state use named Docker volumes. Automatic HTTPS adds an `acme` volume. RustFS runs as container UID/GID `10001`; grant that identity ownership of `objects`. With rootless Docker, do this through a temporary container in the same Docker context rather than guessing the host's mapped UID:

```sh
docker run --rm --user 0 \
  -v /absolute/data/path/objects:/data \
  debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251 \
  chown 10001:10001 /data
docker compose --env-file widefleet-images-0.4.13.env --env-file /absolute/path/deployment.env -f infra/compose.yaml up -d control-plane proxy
docker compose --env-file widefleet-images-0.4.13.env --env-file /absolute/path/deployment.env -f infra/compose.yaml ps --all
```

Compose starts PostgreSQL and storage, then runs the one-time `initialize` service to prepare storage, the database schema, keys and edge/runtime configuration. The runtime starts after initialization succeeds; management waits for the runtime health check. Expect `initialize` to exit successfully and `runtime` and `control-plane` to become healthy. If startup fails, inspect `docker compose ... logs initialize runtime control-plane`. Open `PLATFORM_URL` and complete [first setup](#infrastructure-and-first-start). Infrastructure changes such as domains or TLS mode require recreating the affected services through Compose.

Sign in to management, register an agent, and copy its one-time token into `PLATFORM_AGENT_TOKEN`. Start it with:

```sh
docker compose --env-file widefleet-images-0.4.13.env --env-file /absolute/path/deployment.env -f infra/compose.yaml --profile agent up -d agent
```

Apps belong to the installation organization. Agent registration authorizes an executor for that organization while preserving app and storage identities. Use the same Docker host, node-state directory, routing directory and storage configuration when replacing an executor. A replacement can claim pending or expired jobs without changing apps. The installer manages one runtime node.

Only ports 80 and 443 are published. PostgreSQL, object storage and runtime operator APIs have no host ports. The agent's Docker socket grants host-level control and is available only to the agent. Apps run in separate V8 isolates with app-scoped resource bindings inside the shared runtime container. Compose connects it to the private management and edge networks.

The reference installation is designed for trusted company app creators. Its installation-wide storage credentials are passed to celld, not to app Worker bindings. The runtime has a read-only root filesystem and a persistent writable node-state directory. No additional platform CPU, memory or request-concurrency limits are imposed.

## Versions and updates

Use matching 0.4.13 control-plane, agent, CLI and app runtime releases. The native runtime is celld 0.6.2. Keep the matching source checkout and image manifest with every backup; restoring older images alone does not reverse database or storage changes.

Check the selected and active versions with `widefleet runtime status`. Use the [runtime commands](/reference/runtime#versions-and-updates) to update or roll back with an administrator login. Updating container images and activating a runtime remain separate actions.

## Management members and app collaboration

Widefleet provisions one installation organization automatically. No organization selection is required in the browser or CLI.

| Role   | Permissions                                                                   |
| ------ | ----------------------------------------------------------------------------- |
| Member | Create apps; manage owned apps and apps explicitly shared with them           |
| Admin  | Manage all apps, deployment agents and member roles, except Owner assignments |
| Owner  | Admin permissions plus appointing and changing Owners                         |

After the first verified management sign-in, the person appears under **Members**. Owners and admins can search by name or email and change their role there. Role changes apply to existing browser and CLI sessions on their next API request. At least one Owner must remain. Only Owners can change Owner assignments.

On an app's **Access** tab, **Management access** lets you search members by name or email and grant or revoke app collaboration. A collaborator can deploy, roll back and delete that app; only its owner or an organization administrator can change its grants. Organization administrators retain access independently of individual grants. The CLI's existing `grant` and `revoke` commands remain compatible.

The first administrator is created by setup or the bootstrap file. Subsequent company sign-ins create Members. Role changes persist across restarts. Published apps have separate [access rules](/reference/app-access).

## App access

The **App catalog** link opens the catalog for all signed-in management members. An app's owner or an administrator can publish it to the catalog from its management page and remove it again. Apps start unlisted; only active apps with a deployed version appear. Previews and apps being deleted are excluded. Catalog entries link directly to the running app and do not grant management or app permissions.

The CLI offers the same operations as JSON: `widefleet catalog list`, `widefleet catalog publish APP_UUID` and `widefleet catalog unpublish APP_UUID`. The corresponding authenticated API endpoints are `GET /api/v1/catalog` and `PUT /api/v1/apps/{appId}/catalog` with `{ "listed": true }` or `{ "listed": false }`. Publication requires the app owner or an administrator through every interface.

The shared runtime handles app sign-in using the organization's published configuration. It removes client-supplied identity headers and forwards verified identity to the app; authentication cookies and tokens do not reach app code. The SvelteKit starter exposes the verified identity as `locals.user`.

App access rules are separate from management permissions. Configure them on the app's **Access** tab. See [published app sign-in](/guides/members#opening-published-apps) for login modes, session lifetime and access revocation, and [app access](/reference/app-access) for group rules.

## Logs and recovery

`docker compose ... logs agent` reports job progress. The management UI and `widefleet events` show persisted deployment events. `docker compose ... logs runtime` shows the shared runtime. Keep logs private; user code may log application data.

With [ClickHouse telemetry](/self-hosting/runtime-logs) enabled, `widefleet logs --level error --since 1h --json` queries server and browser failures with private source-map resolution. `widefleet logs --follow` follows incoming telemetry. These commands use current app permissions; ordinary app users do not receive diagnostic access automatically.

App requests and ordinary runtime restarts use persisted routes, runtime artifacts and runtime storage independently of management and the executor. Rejected activation restores the serving deployment. An interrupted activation is recovered by the next executor before new work; allow that recovery before deliberately restarting a node with an unfinished update. See [activation and recovery](/reference/runtime#activation-and-recovery).

## Whole-installation backup and restore

Use an operator-managed, encrypted backup outside this host. Back up a **stopped, consistent installation**, not selected D1 object prefixes. Capture the environment/secrets, pinned image digests, repository revision, PostgreSQL directory, complete object-store directory, runtime state directories, proxy routes and TLS material together.

1. Stop incoming traffic at the proxy, stop new deploy submissions and wait for active deployment jobs to finish. Record the organization ID, active runtime version and deployed app versions.
2. Stop the agent and control plane. Stop the `runtime` service gracefully, allowing its configured 45-second shutdown period. If enabled, stop the OpenTelemetry Collector and ClickHouse; then stop PostgreSQL and RustFS.
3. Archive the complete `PLATFORM_DATA_DIRECTORY` and the `platform-state`, `edge-config`, `runtime-config`, `runtime-state` and optional `acme` volumes, preserving ownership and permissions. Include the Compose project name and overrides, private environment, image manifest and any externally supplied encryption key or infrastructure secrets. The database and its encryption key must be restored together. Do not run `docker compose down --volumes`.
4. Copy the encrypted archive off-host. Start the control plane through Compose, which starts its storage, initialization and runtime dependencies. Start any telemetry services and the agent, then the proxy. Verify an existing database record and its associated file.

To restore on the existing host, stop the same services, restore the complete matching snapshot and environment, and restart with the recorded source and image versions. Do not mix database, object-store or runtime-state snapshots. Do not copy live PostgreSQL data files.

On a replacement host, restore the same absolute data path, Compose project name, named volumes and ownership before starting services. Restore the saved agent credential in the private environment. Start management and its dependencies, then telemetry and the agent. Restrict proxy access to the restore operator while checking sign-in, `widefleet runtime status`, an existing app, a database record and the corresponding private file. The restored runtime state and routes retain the installed deployments. Enable general access after these checks pass. Never run the old and restored runtime against the same storage simultaneously.

Before relying on the backup, complete a restore drill using the installation's actual storage and backup target.
