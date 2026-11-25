---
title: Single-host installation
description: Install Widefleet on one Docker host, connect a deployment agent and deploy a first app.
lastModified: 2026-11-18
---

This guide installs Widefleet **0.7.6** on one Linux host with the reference
Docker Compose configuration: local PostgreSQL, RustFS object storage and a TLS
certificate you provide. At the end, the installation is healthy, a deployment
agent is connected and your first app is running.

For external PostgreSQL, cloud object storage or automatic HTTPS, follow the same
steps and select the additional Compose files described in
[external services and HTTPS](/self-hosting/external-services).

## Prerequisites

- A Linux x86-64 host with Docker Engine 29.8.1 (the tested baseline) and Docker
  Compose 2.20.0 or newer, including v5. The host only needs Docker; the release
  images contain all runtime and setup tools.
- A management hostname and a separate app domain, both pointing to the host, for
  example `platform.example.com` and `*.apps.example.com`. The management
  hostname must be outside the app domain.
- A trusted certificate covering both, as `fullchain.pem` and `privkey.pem`, or
  [automatic HTTPS with Cloudflare](/self-hosting/external-services#automatic-https-with-cloudflare).
- A host sized for the apps you plan to run. All apps share the host's CPU and
  memory.

## Get the release

Clone the repository, check out the release and verify its image manifest. Run
all later commands from the repository root.

```sh
git clone https://github.com/widefleet/widefleet.git
cd widefleet
git checkout v0.7.6
curl -fLO https://github.com/widefleet/widefleet/releases/download/v0.7.6/widefleet-images-0.7.6.env
curl -fLO https://github.com/widefleet/widefleet/releases/download/v0.7.6/widefleet-images-0.7.6.env.sha256
sha256sum --check widefleet-images-0.7.6.env.sha256
```

The manifest pins the three public Docker Hub images by digest. Pulling them
requires no registry login.

| Image                               | Purpose                                   |
| ----------------------------------- | ----------------------------------------- |
| `docker.io/widefleet/control-plane` | Management UI, API and installation setup |
| `docker.io/widefleet/agent`         | Deployment agent                          |
| `docker.io/widefleet/runtime`       | Shared app runtime, including app sign-in |

## Create the deployment environment

Copy `infra/deployment.env.example` to a private file outside version control,
for example `/absolute/path/deployment.env`, with mode `0600`. Set:

| Setting                                     | Value                                                                                                                                               |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PLATFORM_URL`                              | The management origin, such as `https://platform.example.com`.                                                                                      |
| `APP_DOMAIN`                                | The app domain, such as `apps.example.com`.                                                                                                         |
| `PLATFORM_DATA_DIRECTORY`                   | An absolute directory for persistent data, such as `/srv/app-platform`.                                                                             |
| `POSTGRES_PASSWORD`, `S3_SECRET_ACCESS_KEY` | Random hexadecimal values, for example from `openssl rand -hex 32`.                                                                                 |
| `LOGIN_CODE_DELIVERY`                       | `console` (as in the example) prints sign-in codes to the control-plane log. See [sign-in codes](/self-hosting/sign-in-and-settings#sign-in-codes). |
| `DOCKER_SOCKET_FILE`                        | The Docker socket for the agent, usually `/var/run/docker.sock`.                                                                                    |
| `GITHUB_TOKEN` (optional)                   | A GitHub token with public-repository read access. It raises the request limit for the app template catalog and stays on the server.                |

The example sets `COMPOSE_FILE=infra/compose.yaml`, which selects local
PostgreSQL and RustFS. Compose reads this selection from the environment file, so
the commands below need no `-f` arguments. Leave `PLATFORM_AGENT_TOKEN` empty for
now. The ClickHouse passwords are only used with [runtime logs](/self-hosting/runtime-logs).

Every command below changes the installation selected by the environment file
you pass. Check that you pass the intended file.

## Prepare the data directory

Create the data directories under `PLATFORM_DATA_DIRECTORY` (here
`/srv/app-platform`), add your certificate and give RustFS's container
user (UID and GID `10001`) ownership of the object store. The temporary container
works with both rootful and rootless Docker:

```sh
mkdir -p /srv/app-platform/objects /srv/app-platform/agent /srv/app-platform/postgres /srv/app-platform/tls
cp fullchain.pem privkey.pem /srv/app-platform/tls/
docker run --rm --user 0 \
  -v /srv/app-platform/objects:/data \
  debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251 \
  chown 10001:10001 /data
```

Keys, generated configuration and runtime state live in named Docker volumes,
which Compose creates on first start.

## Pull the release images

```sh
docker compose --env-file widefleet-images-0.7.6.env --env-file /absolute/path/deployment.env --profile agent pull
```

This pulls the three Widefleet images and the PostgreSQL, RustFS and Traefik
dependencies. Keep the image manifest together with the private deployment
environment; every Compose command needs both files.

## Start the platform

```sh
docker compose --env-file widefleet-images-0.7.6.env --env-file /absolute/path/deployment.env up -d control-plane proxy
docker compose --env-file widefleet-images-0.7.6.env --env-file /absolute/path/deployment.env ps --all
```

Compose starts PostgreSQL and RustFS, runs the one-time `initialize` service to
prepare storage, the database, keys and configuration, then starts the runtime
and management. The installation is ready when `initialize` has exited with code
`0` and `runtime` and `control-plane` are `healthy`. Then
`https://platform.example.com/healthz` responds successfully.

If startup fails, read the service logs:

```sh
docker compose --env-file widefleet-images-0.7.6.env --env-file /absolute/path/deployment.env logs initialize runtime control-plane
```

## Complete first setup

The first person who completes the setup form becomes the installation's Owner.
Keep `PLATFORM_URL` reachable only by you until setup is complete, or use
[automated first setup](/self-hosting/sign-in-and-settings#automated-first-setup).

1. Open `PLATFORM_URL`, enter the organization name, your name and your email,
   and request a sign-in code.
2. With console delivery, read the code from the control-plane log:

   ```sh
   docker compose --env-file widefleet-images-0.7.6.env --env-file /absolute/path/deployment.env logs --since=5m control-plane
   ```

3. Enter the code. Codes expire after five minutes and allow three incorrect
   attempts.

**Publish your first app** opens. The installation has one organization; you add
colleagues later through company sign-in or invitations.

## Connect the deployment agent

1. In management, open **Deployment agents → Register deployment agent**, enter a
   name and choose **Register agent**.
2. Copy the access key into `PLATFORM_AGENT_TOKEN` in the deployment environment.
   The key is shown only once.
3. Start the agent:

   ```sh
   docker compose --env-file widefleet-images-0.7.6.env --env-file /absolute/path/deployment.env --profile agent up -d agent
   ```

**Deployment agents** now shows a **Last seen** time for the agent.

## Deploy a first app

On your workstation, [install the CLI](/getting-started/installation#install-the-cli),
then create and deploy the starter app:

```sh
widefleet login --url https://platform.example.com
widefleet init my-first-app
cd my-first-app
pnpm install
widefleet deploy
```

The deployment prints the app's address. Open it and sign in: the starter's
notes app loads. Your installation is working.

## Security of the reference installation

- Only ports 80 and 443 are published. PostgreSQL, object storage and the runtime's
  operator APIs have no host ports.
- Only the agent mounts the Docker socket, which grants host-level control. Keep it
  out of every other service, including management.
- Apps run in separate V8 isolates inside the shared runtime container, which has
  a read-only root filesystem. Each app sees only its own resources; the
  installation's storage credentials stay with the runtime.
- The reference installation is designed for trusted company app creators.

## Next steps

1. Connect your identity provider with [Set up company sign-in](/guides/company-sign-in),
   then [invite colleagues and manage roles](/guides/members).
2. Review [sign-in and settings](/self-hosting/sign-in-and-settings) for sign-in
   codes, automated setup and administrator recovery.
3. Plan [updates, backups and troubleshooting](/self-hosting/operations).
4. Let employees and their agents find the installation with
   [company setup](/self-hosting/company-setup).
