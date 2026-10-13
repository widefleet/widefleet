---
title: Cloudflare control plane
description: Build and initialize the management application with Hyperdrive and R2 bindings.
lastModified: 2026-10-13
---

Run Widefleet management on Cloudflare Workers with PostgreSQL through Hyperdrive and artifacts in R2. This target is unreleased; use a source checkout containing the Cloudflare control-plane implementation. It covers management, company login, CLI authorization and artifact uploads. Deployment requests are saved as jobs; hosted app execution, app sign-in and app-log queries are not connected yet.

## Prerequisites

Use Node.js 26.8.2, pnpm 12.4.2, a Widefleet source checkout and a Workers Paid account. Provision a separate PostgreSQL database, Hyperdrive configuration and R2 bucket for this installation. PlanetScale PostgreSQL can serve as the database origin. The initialization identity needs permission to create the tables, indexes and migration schema in that database.

Configure Hyperdrive to use verified TLS to PostgreSQL and **disable query caching**. Management reads must observe committed changes to sessions, permissions, settings and jobs. The Worker binding supplies Hyperdrive's connection string; the initialization command connects directly to PostgreSQL. See [Hyperdrive query caching](https://developers.cloudflare.com/hyperdrive/concepts/query-caching/) for the resource setting.

Prepare a management hostname in a Cloudflare zone and keep the installation's resource configuration in your versioned deployment project. Run the commands below from the Widefleet repository root.

## Configure the Worker

Install the checked-in dependency versions:

```sh
pnpm install --frozen-lockfile
```

Set the following in `apps/control-plane/wrangler.jsonc` through your normal configuration review:

| Setting | Value for this installation |
| --- | --- |
| `name` | A unique control-plane Worker name |
| `vars.PLATFORM_URL` | The management HTTPS origin, such as `https://platform.example.com` |
| `vars.APP_DOMAIN` | The installation's app hostname suffix, such as `apps.example.com` |
| `hyperdrive[0].id` | The Hyperdrive configuration ID with query caching disabled |
| `r2_buckets[0].bucket_name` | The installation's artifact bucket |

Retain the `HYPERDRIVE`, `ARTIFACTS` and `ASSETS` binding names. `localConnectionString` is used only for local development. The checked-in ID and domains are placeholders; the template does not expose a public route.

For a management Custom Domain, add the route to the same configuration:

```json
{
  "routes": [
    { "pattern": "platform.example.com", "custom_domain": true }
  ]
}
```

Keep `workers_dev` and `preview_urls` disabled when using that domain. Management routing is handled by Cloudflare; this Worker does not require Traefik.

Supply two independent, randomly generated secrets through the deployment's secret store:

- `BETTER_AUTH_SECRET`: at least 32 characters, used by management authentication.
- `PLATFORM_ENCRYPTION_KEY`: at least 32 characters, used to encrypt installation and app secrets in PostgreSQL.

Use the same values for initialization and the Worker. Preserve them across builds and deployments, and include them in the installation's recovery plan. The Worker does not create key files or generate replacement keys. Keep secrets out of `wrangler.jsonc` and Git.

## Initialize PostgreSQL

Create a private bootstrap JSON file containing the first administrator. Replace the example credentials before use:

```json
{
  "owner": {
    "name": "Administrator",
    "email": "administrator@example.com",
    "password": "replace-with-a-unique-administrator-password"
  }
}
```

Create a private environment file with the values below. Use the direct PostgreSQL connection string supplied for this installation, with URL-encoded credentials and verified TLS:

```dotenv
DATABASE_URL=postgres://widefleet:URL_ENCODED_PASSWORD@database.example.com:5432/widefleet?sslmode=verify-full
PLATFORM_URL=https://platform.example.com
APP_DOMAIN=apps.example.com
BETTER_AUTH_SECRET=REPLACE_WITH_THE_INSTALLATIONS_AUTHENTICATION_SECRET
PLATFORM_ENCRYPTION_KEY=REPLACE_WITH_THE_INSTALLATIONS_ENCRYPTION_KEY
PLATFORM_BOOTSTRAP_FILE=/absolute/bootstrap.json
```

Restrict both files to the operator account. Run initialization in the installation's approved deployment process before publishing the Worker:

```sh
node --env-file=/absolute/hosted.env apps/control-plane/tools/initialize-cloudflare.ts
```

The command applies migrations, registers the CLI OAuth client and creates the first administrator. A successful run prints `Hosted installation initialized`. Repeating it applies outstanding migrations and updates the CLI registration while preserving the existing owner and settings. The bootstrap file is only required while there is no owner; remove it from the deployment job after initialization and retain credentials in the secret store.

HTTP requests do not run migrations or bootstrap the installation. If the installation has no owner, management returns HTTP 503 instead of offering public first-admin setup.

## Build and verify

Build and check the deployment package locally:

```sh
pnpm --filter @platform/control-plane build:cloudflare
pnpm --filter @platform/control-plane exec wrangler deploy --dry-run --outdir dist/cloudflare/bundle
```

The dry run performs no deployment. Publish the configured Worker and its secrets through your reviewed deployment process. The regular `build` and `start` commands continue to select the Node control plane.

After publishing, verify that `/healthz` returns `{"status":"ok"}`. Open `/sign-in` and sign in with the initialized administrator, then verify CLI authorization:

```sh
widefleet --url https://platform.example.com login
widefleet --url https://platform.example.com whoami
```

The Wrangler template enables Workers observability for management logs. The current app sign-in status remains `waiting` because the hosted app sign-in service is not connected.

If startup fails, check that the two Worker secrets match initialization, Hyperdrive targets the initialized database and its cache is disabled, and the configured management origin matches the public hostname. If initialization reports a missing bootstrap file, provide it and rerun initialization; do not expose the Node setup flow as a workaround. Inspect management errors in Cloudflare Workers Logs.

The observable result is a management UI and API backed by this installation's PostgreSQL database, with CLI login and R2 artifact storage. Continue with [company configuration](/self-hosting/company-setup) to distribute the management URL to employees. Hosted app execution remains outside this target's current support.
