---
title: Single-host installation
description: Install, configure, upgrade and recover a company installation.
lastModified: 2026-10-22
---

This Compose deployment is the reference installation. Use Linux x86-64, Docker Engine 29.8.1, Docker Compose 2.20.0 or newer (including v5), and a checkout of the matching release. Published images contain the required runtime and setup tools; the operator host needs no Node, pnpm or Rust installation. The operator owns DNS, certificates, identity-provider registrations, backups and upgrades. Commands below change the selected installation; choose its environment file deliberately.

This page describes local PostgreSQL, RustFS and operator-provided certificates. [External services and automatic HTTPS](/self-hosting/external-services) use the same maintained base configuration with selectable service files.

Docker 29.8.1 is the tested host baseline, pinned in CI. Its network address allocation supports the fleet's fixed app addresses; see the [29.x release notes](https://docs.docker.com/engine/release-notes/29/#2904).

## Infrastructure and first start

For unreleased organization sign-in builds, settings and encrypted credentials are
scoped to the selected organization. Before upgrading a serving installation from fleet
ownership, complete and verify an explicit runtime-state migration first. See the
[organization ownership upgrade requirements](/reference/runtime#organization-ownership-upgrade)
for its scope.
The database migration preserves the installation settings under `widefleet`. Startup then
moves the saved workspace SSO registration into the native provider store and removes the
old editable identity document. The shared registration replaces the former separate app
credentials, so register both callbacks on the saved workspace client. Directory credentials
are retained. This does not move object storage or local node state.
Updating components or redeploying apps alone cannot migrate that state.
After completing the state migration, upgrade the control plane,
agent and runtime together; register the newly displayed app callback URL
(`https://auth.APP_DOMAIN/oauth2/widefleet/callback` for the installation organization),
reapply sign-in settings and redeploy existing apps to publish their organization-bound
auth routes. Management callbacks now use `/api/auth/sso/callback/PROVIDER_ID`; copy the
exact URL from Settings into the IdP registration. Saved providers are not automatically
marked domain-verified. Use the installation [recovery link](#secrets-and-administrator-recovery) if no email-code login is available, enter the company domain, save, complete DNS verification and activate company SSO. Existing app sessions and CLI tokens require a fresh sign-in.
Local password authentication is removed in these builds. The migration deletes password
credentials and the former database flag while preserving users, memberships and SSO accounts.
Before upgrading, configure email-code delivery, explicitly choose `LOGIN_CODE_DELIVERY=console`,
or verify that company SSO works. Remove `owner.password` from any pending bootstrap file.
Company SSO and directory settings remain organization-scoped database configuration.
These builds also support [member invitations and company sign-in](/guides/members)
when an email adapter is configured; the default self-hosted build does not add a mail service.

Copy `infra/deployment.env.example` to a private file outside version control. Set the database/storage credentials, `PLATFORM_URL`, `APP_DOMAIN` and the absolute `PLATFORM_DATA_DIRECTORY`. The management hostname must be outside the app domain, for example `platform.example.test` and `*.apps.example.test`. Configure DNS and provide `${PLATFORM_DATA_DIRECTORY}/tls/fullchain.pem` and `privkey.pem`, or select [automatic HTTPS](/self-hosting/external-services#automatic-https-with-cloudflare).

Configure company SSO, directory credentials and browser editability in **Settings**; these are stored in PostgreSQL. Widefleet generates its authentication, app-cookie and encryption keys in the persistent `platform-state` volume. Preserve that volume across deployments.

**Keep first setup accessible only to the installing administrator**, or supply the [bootstrap file](#automated-first-setup) before exposing the installation. The first person who completes the setup form becomes Owner; there is no initial shared password or setup key. Once claimed, this endpoint cannot create another administrator.

For interactive first setup, choose a sign-in-code transport before starting the containers:

- `LOGIN_CODE_DELIVERY=email` is the default. It requires a configured email adapter; the standard self-hosted build does not include a mail service.
- `LOGIN_CODE_DELIVERY=console` explicitly prints sign-in codes to the control-plane log. The example deployment environment selects this operator mode. Read it with `docker compose ... logs --since=5m control-plane`. Log readers can use the codes, so keep logs private. Console delivery does not prove control of the email inbox, although Better Auth marks a successful email-code login as email-verified. Use email delivery or company SSO for ordinary users.

This setting controls sign-in codes only. Invitations still require an email adapter. Mail failures never switch delivery to the console. Changing the transport requires recreating the control-plane container and does not revoke existing sessions.

Open `PLATFORM_URL`:

1. Create the first administrator with a name and email, then request a sign-in code. Read it from the selected transport and sign in. Codes expire after five minutes and allow three incorrect attempts.
2. To use company SSO, enter the issuer URL and choose the app identity claims: Microsoft Entra for Entra object IDs and group handling, or OpenID Connect for standard subjects and configurable group claims. The page shows both callback URLs before saving.
3. Register both callbacks in one IdP registration and enter its client ID and secret once. Enable directory search only if needed.
4. Enter your company email domain and publish the DNS TXT record shown by **Get verification record**. Choose **Verify domain**, then **Test company sign-in** and authenticate with the same email as the first administrator. Widefleet links that account automatically and checks its administrator access.
5. Choose **Activate company SSO**. Company SSO becomes required for the operator organization. Existing email-code sessions can no longer access it; the operator recovery command remains available. An email-code login cannot bypass required SSO.

Customer administrators can change their own SSO and directory settings without restarting the platform.

Company sign-in automatically enrolls users admitted by the organization's provider as Members who can create apps, including external guests. Restrict the shared IdP registration to the intended users. Existing memberships keep their roles, and pending invitations retain their acceptance flow. Without company SSO, customers join through invitations. Apps enforce their own access rules and business permissions using the verified user and group context.

Management uses Better Auth's SSO plugin for OIDC discovery, callbacks, provider registration and DNS verification. Existing accounts with a matching email in the verified company domain are linked automatically, retaining their membership and role. External guests admitted by the provider can join, but a different email domain does not establish trusted linking to an existing account. See [company SSO activation](/guides/members#activate-company-sso) for CLI commands and provider replacement behavior.

Known runtime limitation: celld `0.6.2` drops incoming header values containing non-ASCII bytes. Display names can therefore be empty in Workers; the stable user identifier remains available for authorization.

For unreleased organization sign-in builds, the Node control plane uses Better Auth's
in-memory request limiter. Counters are per process, reset on restart, and do not use
PostgreSQL. Requests from the same IP share an endpoint's limit; users behind a shared
proxy can therefore affect each other. A `429` response includes an `X-Retry-After`
delay. The per-email-code attempt limit remains in the stored verification record.

### Automated first setup

Mount a JSON file read-only into the control-plane container and set `PLATFORM_BOOTSTRAP_FILE` to its container path. The file must be readable by the container user. Keep it and its parent directory protected on the host.

```json
{
  "owner": {
    "name": "IT Administrator",
    "email": "admin@example.com"
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

`settings` is optional. SSO credentials belong to the native provider configuration; directory credentials, when used, accept a `clientSecret` string. Both are encrypted before storage. A Compose override can mount the bootstrap file; it must not mount the host Docker socket into management.

For example, add this override to the selected Compose files (the source paths must already exist):

```yaml
services:
  control-plane:
    environment:
      PLATFORM_BOOTSTRAP_FILE: /run/widefleet/bootstrap.json
    volumes:
      - /absolute/private/bootstrap.json:/run/widefleet/bootstrap.json:ro
```

The bootstrap file initializes the administrator and the optional settings once. If initialization fails after creating the administrator, the next start resumes with that account. Keep the file mounted, correct the reported configuration or provider failure, and restart until initialization succeeds. After successful initialization, the file is ignored and can be removed; later UI/API changes survive restarts. The bootstrap file does not prove domain ownership. File initialization uses a short-lived operator session that is closed afterwards; it does not send a code or mark the owner’s email as verified. Use an email-code login or a recovery link to complete DNS verification and test the company login.

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

The CLI and external integrations use `GET/PUT /api/v1/settings`, `POST /api/v1/settings/plan` and `PUT /api/v1/settings/external-management`. The UI uses SvelteKit remote functions that call the same settings service. Administrator permission is required through either entry point. Exports omit the SSO secret, which the native provider preserves when unchanged. Set `sso.oidcConfig.clientSecret` to replace it. Directory secrets are exported as references scoped to the selected organization. Stored secret values are never returned.

External management makes the settings UI read-only; API/CLI writes and app management remain available. An administrator can turn browser editing back on.

Settings are validated before saving. The shared runtime applies app sign-in configuration
without restarting. Activation status distinguishes saved settings from a published
configuration, and remains waiting while company-domain verification is pending. If
publication fails, correct the runtime connection and save again. A future runtime requiring
a restart must report it through the same plan and acknowledgement flow.

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
3. Configure the **ID token** to emit **Group ID** in the `groups` claim. Keep object IDs rather than group names and do not select **Emit groups as role claims**: the current proxy reads `groups`.
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

Releases provide four public Linux amd64 images on Docker Hub. Pulling them does not require a GitHub account or registry login:

| Image                               | Purpose                                                                             |
| ----------------------------------- | ----------------------------------------------------------------------------------- |
| `docker.io/widefleet/control-plane` | Management server, API, database/storage initialization and edge configuration tool |
| `docker.io/widefleet/agent`         | Deployment agent and its matching celld publish executable                          |
| `docker.io/widefleet/sso`           | Independent OAuth2 Proxy and configuration supervisor                               |
| `docker.io/widefleet/runtime`       | celld runtime used for the shared fleet                                             |

Every image has the same release tag, for example `0.3.0`, and OCI labels for its source repository, source commit and version. Installation uses exact digests from the release attachment `widefleet-images-VERSION.env`, verified with its accompanying `.sha256` file. There is no floating `latest` tag and no automatic update of running installations.

From the repository root, use the matching release configuration and download its digest manifest. Replace `VERSION` with the release version. The files are also available on [GitHub Releases](https://github.com/widefleet/widefleet/releases).

```sh
git checkout vVERSION
curl --fail --location --remote-name https://github.com/widefleet/widefleet/releases/download/vVERSION/widefleet-images-VERSION.env
curl --fail --location --remote-name https://github.com/widefleet/widefleet/releases/download/vVERSION/widefleet-images-VERSION.env.sha256
sha256sum --check widefleet-images-VERSION.env.sha256
```

The non-secret configuration manifest contains the four `docker.io/widefleet/` image references pinned by SHA-256 digest. Keep it with the private deployment environment and supply both files to Compose. Pull **all four images**, including the runtime used by new app containers:

```sh
docker compose --env-file widefleet-images-VERSION.env --env-file /absolute/path/deployment.env -f infra/compose.yaml --profile agent --profile images pull
```

The `runtime-image` service is a pull target, not a long-running service. The agent uses that exact `PLATFORM_RUNTIME_IMAGE` on the same Docker daemon. The agent expects this image to be present locally. For multiple agent hosts, pull the runtime on each host using its own Docker context.

## Start services

Create the data directory and its `objects`, `agent`, `postgres` and `tls` subdirectories. Configuration, authentication keys and ACME state use named Docker volumes. RustFS runs as container UID/GID `10001`; grant that identity ownership of `objects`. With rootless Docker, do this through a temporary container in the same Docker context rather than guessing the host's mapped UID:

```sh
docker run --rm --user 0 \
  -v /absolute/data/path/objects:/data \
  debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251 \
  chown 10001:10001 /data
docker compose --env-file widefleet-images-VERSION.env --env-file /absolute/path/deployment.env -f infra/compose.yaml up -d postgres storage
docker compose --env-file widefleet-images-VERSION.env --env-file /absolute/path/deployment.env -f infra/compose.yaml run --rm control-plane node tools/initialize-storage.ts
docker compose --env-file widefleet-images-VERSION.env --env-file /absolute/path/deployment.env -f infra/compose.yaml up -d control-plane oauth2-proxy proxy
```

Management creates the schema, CLI registration and static edge configuration at startup. The edge and SSO containers need neither a Docker socket nor a connection to the management database. Initial SSO waits until the administrator supplies its settings. Infrastructure changes such as domains or TLS mode still require recreating the affected services through Compose.

Sign in to management, register an agent, and copy its one-time token into `PLATFORM_AGENT_TOKEN`. Start it with:

```sh
docker compose --env-file widefleet-images-VERSION.env --env-file /absolute/path/deployment.env -f infra/compose.yaml --profile agent up -d agent
```

App creators use the installation's default fleet. Agent registration authorizes an executor for that fleet while preserving app and storage identities. Use the same Docker host, node-state directory, routing directory and storage configuration when replacing an executor. A replacement can claim pending or expired jobs without changing apps. The installer manages one runtime node.

Only ports 80 and 443 are published. PostgreSQL, object storage and runtime operator APIs have no host ports. The agent's Docker socket grants host-level control and is available only to the agent. Apps run in separate V8 isolates with app-scoped resource bindings inside a shared fleet container and Docker network. The trusted proxy and storage container join that network.

The reference installation is designed for trusted company app creators. Its installation-wide storage credentials are passed to celld, not to app Worker bindings. The runtime has a read-only root filesystem and a persistent writable node-state directory. No additional platform CPU, memory or request-concurrency limits are imposed.

## Upgrade deliberately

When moving from fleet ownership to the unreleased organization ownership build, complete
the [state migration requirements](/reference/runtime#organization-ownership-upgrade)
before recreating services or redeploying existing apps.

Container publication does not change a running installation. Select the intended source checkout and matching image manifest, back up the deployment, pull its images and recreate the affected services. The control plane applies its schema at startup. Preserve the keys and runtime volumes; selecting an older image does not reverse a schema change. Recreate Traefik for changes to static TLS configuration or ACME environment.

The Widefleet JavaScript loader has its own release lifecycle. Use `widefleet runtime status`, `widefleet runtime update VERSION` and `widefleet runtime rollback PREVIOUS_VERSION` with the normal administrator login. These commands manage the default fleet and handle artifact transfer and activation automatically; no UUID, release file or revision number is required. See [application runtime](/reference/runtime).

`PLATFORM_RUNTIME_IMAGE` identifies the celld container image, separate from that JavaScript release. Existing fleet containers retain their image until recreation. Changing celld itself requires a reviewed migration procedure for native storage and node state. The current runtime is pinned to celld 0.6.2; the agent image inherits the same binary for publishing deployments.

Before changing fleet storage, recovering an interrupted activation or publishing a deployment, the agent checks the publisher binary, the selected runtime image and retained fleet-container images with `celld --version`. Image checks capture output directly from disposable containers with stored logging disabled, without network access or fleet-state mounts; new fleet containers use the verified immutable image ID. A mismatch fails the job with the required version and the component to replace. Updating a JavaScript package does not upgrade celld or recreate an incompatible native container.

### Upgrading from 0.2.1 to 0.3.0

This release pairs platform and CLI 0.3.0 with app runtime 0.2.1. The native runtime remains celld 0.6.2, so this upgrade does not require a native storage migration or replacement of an existing compatible fleet container.

1. Drain deployment jobs and stop the agent. Back up PostgreSQL, cloud object storage, local fleet state, authentication/configuration volumes and secrets before changing the installation.
2. Select the 0.3.0 source and verified image manifest. Recreate the management server, SSO and agent through the existing Compose configuration, preserving installation keys, volumes and operator settings. Management applies the additive migrations for app migrations, access groups, the preview-parent index, the catalog and Workflow operations. Upgrade management and the agent together before configuring access groups or deploying Workflows.
3. Install CLI 0.3.0 and use an administrator session to run `widefleet runtime update 0.2.1`. Verify that `widefleet runtime status` reports active version 0.2.1 and successful activation before deploying Workflow bindings. Check an existing app and its persisted data after activation.

Existing apps retain company SSO access: their initial group lists are empty, meaning all users admitted by company SSO. Previews inherit their original app's policy. Catalog publication is opt-in and existing apps remain unlisted. See [app access](/reference/app-access) and [App Workflows](/guides/workflows) for configuration and compatibility limits.

Runtime downgrades without Workflow support are rejected while published apps retain Workflow versions. Selecting older container images does not undo database migrations; a full rollback requires restoring the matching backup and platform components together. Installations older than 0.2.1 must first follow the native runtime upgrade below.

### Upgrading from 0.2.0 to 0.2.1

This upgrade pairs the 0.2.1 platform and CLI with app runtime 0.1.1 and celld 0.6.2. The previous app runtime 0.1.0 requires celld 0.6.1 and cannot be selected by the new platform. Upstream celld supports upgrading 0.6.1 to 0.6.2 without replacing native storage, but Widefleet requires an explicit fleet-container replacement.

1. Prevent new requests and deployments, drain queued/running jobs, and stop the agent, management and fleet container. Capture a consistent backup of PostgreSQL, cloud object storage, local fleet state, authentication/configuration volumes, secrets and the previous container configuration. Keep an encrypted copy outside the host.
2. Install the matching 0.2.1 source and verified image manifest. Recreate management and SSO through the existing Compose selection, preserving the project name, data paths, volumes and operator settings. Management applies the additive installation-reporting migration; reporting defaults and opt-outs are described in [installation reporting](/self-hosting/installation-reporting).
3. Replace the stopped fleet container with the selected 0.2.1 runtime image while preserving its command, environment, mounts, labels, network address and security settings. Retain the old container with automatic restart disabled and a name outside the agent's active/recovery container names. Never run both containers against the same fleet storage.
4. Start the replacement, then use the 0.2.1 CLI and an administrator session to queue `widefleet runtime update 0.1.1 --no-wait`. Start the matching agent and verify that `widefleet runtime status` reports active version 0.1.1 and a successful update. Restore public traffic after checking the saved apps and their data.

An older image or `widefleet runtime rollback 0.1.0` is insufficient to undo this upgrade. A full rollback must restore the matching database, object storage and local-state backup with the old platform, runtime package and native container together.

App-tail telemetry configuration is included in app snapshots at deployment. Enabling or changing it does not require recreating the fleet container. See [telemetry](/self-hosting/runtime-logs) for capture limits.

Use the matching [CLI release](/getting-started/installation) to access the settings commands.

## Management members and app collaboration

Widefleet uses Better Auth's Organization plugin with one automatically provisioned installation organization. No organization selection is required in the browser or CLI.

| Role   | Permissions                                                                   |
| ------ | ----------------------------------------------------------------------------- |
| Member | Create apps; manage owned apps and apps explicitly shared with them           |
| Admin  | Manage all apps, deployment agents and member roles, except Owner assignments |
| Owner  | Admin permissions plus appointing and changing Owners                         |

After the first verified management sign-in, the person appears under **Members**. Owners and admins can search by name or email and change their role there. Role changes apply to existing browser and CLI sessions on their next API request. At least one Owner must remain, using Better Auth's native owner checks. Only Owners can change Owner assignments.

On an app's **Access** tab, **Management access** lets you search members by name or email and grant or revoke app collaboration. A collaborator can deploy, roll back and delete that app; only its owner or an organization administrator can change its grants. Organization administrators retain access independently of individual grants. The CLI's existing `grant` and `revoke` commands remain compatible.

The first administrator is created by setup or the bootstrap file. Subsequent company sign-ins create Members. Role changes persist across restarts. Published apps have separate [access rules](/reference/app-access).

## App access

The **App catalog** link opens the catalog for all signed-in management members. An app's owner or an administrator can publish it to the catalog from its management page and remove it again. Apps start unlisted; only active apps with a deployed version appear. Previews and apps being deleted are excluded. Catalog entries link directly to the running app and do not grant management or app permissions.

The CLI offers the same operations as JSON: `widefleet catalog list`, `widefleet catalog publish APP_UUID` and `widefleet catalog unpublish APP_UUID`. The corresponding authenticated API endpoints are `GET /api/v1/catalog` and `PUT /api/v1/apps/{appId}/catalog` with `{ "listed": true }` or `{ "listed": false }`. Publication requires the app owner or an administrator through every interface.

Traefik clears client-supplied identity headers, checks SSO through OAuth2 Proxy, copies only the verified identity, then removes `Cookie`, `Authorization` and token headers before forwarding to an app. App responses cannot set cookies. The SvelteKit starter populates `locals.user` from the verified identity through its included server identity helper.

App-side cookie sessions and frameworks requiring server cookies are unsupported. The management login has its own host-only cookies. App SSO uses a one-hour encrypted cookie with no stored OAuth tokens and no refresh token; after expiry, the browser returns through the identity provider. Disabling a user there does not invalidate an already-issued app cookie immediately. `/oauth2/*` and the `auth` app hostname are reserved for the proxy.

## Logs and recovery

`docker compose ... logs agent` reports job progress. The management UI and `widefleet events` show persisted deployment events. `docker logs platform-fleet-<fleet-id>` shows the runtime. Keep logs private; user code may log application data.

With [ClickHouse telemetry](/self-hosting/runtime-logs) enabled, `widefleet logs --level error --since 1h --json` queries server and browser failures with private source-map resolution. `widefleet logs --follow` follows incoming telemetry. These commands use current app permissions; ordinary app users do not receive diagnostic access automatically.

App requests and ordinary runtime restarts use persisted routes, runtime artifacts and fleet storage independently of management and the executor. Rejected activation restores the serving deployment. An interrupted activation is recovered by the next executor before new work; allow that recovery before deliberately restarting a node with an unfinished update. See [activation and recovery](/reference/runtime#activation-and-recovery).

## Whole-installation backup and restore

Use an operator-managed, encrypted backup outside this host. Back up a **stopped, consistent installation**, not selected D1 object prefixes. Capture the environment/secrets, pinned image digests, repository revision, PostgreSQL directory, complete object-store directory, runtime state directories, proxy routes and TLS material together.

1. Stop incoming traffic by stopping the proxy. Stop new deploy submissions and wait until the deployment queue has no active jobs. Record the fleet ID, active runtime version and each app's successful artifact ID.
2. Stop the agent and control plane. Gracefully stop the `platform-fleet-<fleet-id>` container with a timeout of at least 30 seconds. Save the exact list of stopped containers and `docker inspect` output in the protected backup.
3. Stop OAuth2 Proxy and, if enabled, the OpenTelemetry Collector and ClickHouse; then stop PostgreSQL and RustFS. Archive the complete `PLATFORM_DATA_DIRECTORY`, the `platform-state`, `edge-config`, `app-auth` and optional `acme` named volumes, preserving ownership and permissions, plus the private deployment environment, an externally supplied encryption key if configured, and infrastructure secrets such as the Cloudflare token. The encrypted database alone cannot restore provider secrets. Do not run `docker compose down --volumes`.
4. Copy the encrypted archive off-host. Restart storage, PostgreSQL and any telemetry services, then the existing app containers, management, agent, OAuth2 Proxy and finally the edge proxy. Verify a saved note and photo.

To restore on the existing host, stop the same services, restore the complete matching snapshot and environment, and restart with the recorded image versions. Do not combine PostgreSQL, fleet storage or node-state directories from different snapshots. Do not copy live PostgreSQL data files.

On a replacement host, restore the same absolute data path and ownership, install the pinned images, and start PostgreSQL, storage and management. During recovery, restrict the proxy to the restore operator so the CLI can reach its configured HTTPS management origin while app users remain excluded. Restore the agent credential. Queue the recorded successful artifact for every restored app with `widefleet rollback <app-id> <artifact-id> --no-wait`; start the agent to restore the shared runtime and app routes. This republishes code while retaining the restored fleet data. Enable general access only after verifying identities, a database record and the corresponding private file. Never run old and restored fleet nodes against the same bucket simultaneously.

Before relying on the backup, complete a restore drill using the installation's actual storage and backup target.
