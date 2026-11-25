---
title: Operations
description: Update, troubleshoot, back up and restore a self-hosted installation.
lastModified: 2026-11-18
---

Run these tasks on the installation host from the repository root, passing the
installation's image manifest and private deployment environment to every
Compose command. The commands change the installation selected by that
environment file.

## Versions and updates

Run matching control-plane, agent, CLI and app runtime releases. Updating
container images and updating the app runtime are separate steps; a new
control-plane release never changes the selected runtime on its own.

1. [Back up the installation](#back-up-and-restore).
2. Check out the new release tag, then download and verify its image manifest as
   in [Get the release](/self-hosting/installation#get-the-release).
3. Pull and start the new images with the new manifest:

   ```sh
   docker compose --env-file widefleet-images-VERSION.env --env-file /absolute/path/deployment.env --profile agent pull
   docker compose --env-file widefleet-images-VERSION.env --env-file /absolute/path/deployment.env up -d control-plane proxy
   docker compose --env-file widefleet-images-VERSION.env --env-file /absolute/path/deployment.env --profile agent up -d agent
   ```

4. Update the app runtime with an administrator login:
   `widefleet runtime update VERSION`. See the
   [runtime commands](/reference/runtime#versions-and-updates) for status and
   rollback.
5. Check that `widefleet runtime status` reports the new version as active, and
   open an existing app.

Keep the source checkout and image manifest that match each backup. To return to
an earlier release, restore the backup taken before the update; older images
alone do not reverse database or storage changes.

Widefleet serves [MCP](/guides/mcp) at `mcp.APP_DOMAIN` through the existing app
wildcard DNS and certificate. The app names `mcp` and `auth` are reserved for
platform services. To offer Google and Microsoft on the MCP connection page, add
the [MCP redirect addresses](/reference/social-sign-in#configure-an-installation).

## Change infrastructure settings

Domains, TLS mode, sign-in code delivery, reporting and `GITHUB_TOKEN` are set in
the deployment environment. After editing it, run the
[start commands](/self-hosting/installation#start-the-platform) again, plus the
agent command if agent settings changed. Compose recreates the services whose
configuration changed. Settings in the management UI apply without restarts.

## Logs and troubleshooting

| Source                                     | Shows                                                        |
| ------------------------------------------ | ------------------------------------------------------------ |
| `docker compose ... logs agent`            | Deployment job progress                                      |
| `docker compose ... logs runtime`          | The shared app runtime                                       |
| `docker compose ... logs control-plane`    | Management, including email delivery errors                  |
| `docker compose ... logs proxy`            | Traefik routing and certificate issuance                     |
| Management UI, `widefleet events`          | Persisted deployment events per app                          |
| [Runtime logs](/self-hosting/runtime-logs) | App errors and console output, queried with `widefleet logs` |

`...` stands for the two `--env-file` arguments. Keep logs private; app code can
log application data.

| Symptom                                                                  | What to do                                                                                                            |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| A deployment or app access rule does not activate                        | Check the agent, runtime and proxy logs, correct the cause and retry. The previous version keeps serving meanwhile.   |
| Sign-in settings do not activate                                         | Check the runtime's health and logs, then save the settings again.                                                    |
| The template catalog returns `503`                                       | The GitHub request limit is exhausted or `GITHUB_TOKEN` is invalid. Set a valid token or wait for the limit to reset. |
| Apps report a missing `WIDEFLEET_IDENTITY` or cannot get workload tokens | Run matching releases of all platform components, check the runtime's health and that its storage is reachable.       |
| A new preview is not yet reachable over HTTPS                            | Its certificate is still being issued. Check the proxy logs if it does not arrive.                                    |

## Activation and recovery

Each deployment switches the app to a new immutable snapshot; requests already
running finish on the previous one. Changes to resources, event subscriptions or
the runtime itself also reload the runtime configuration, which Widefleet
validates before publishing. Runtime updates are checked against every published
app before they are accepted. During a reload the previous version keeps
serving, and long-lived connections drain from it.

When an activation is rejected, the previous deployment stays in place, also
across restarts. If the agent stops during an activation, the next agent start
completes the recovery before taking new work. Let that finish before you
restart the host deliberately.

Published apps, app sign-in, workload identity tokens and ordinary runtime
restarts need neither management nor a running agent. They depend on the proxy,
the runtime, its storage and your identity provider.

## Replace the deployment agent

Apps belong to the organization, not to an agent, so replacing an agent leaves
apps and their data unchanged.

1. [Register a new agent](/self-hosting/installation#connect-the-deployment-agent)
   and put its access key into `PLATFORM_AGENT_TOKEN`.
2. Start it on the same Docker host with the same data directory, named volumes
   and storage configuration. It picks up pending and expired jobs.
3. Disable the old agent under **Deployment agents**.

The reference installation manages one runtime node.

For a custom topology, set the agent's `PLATFORM_APP_RUNTIME_URL` (default
`http://runtime:8080/`) and `PLATFORM_PROXY_URL` (default
`https://app-platform-proxy:8443`) to private origins the relevant services can
reach, and keep the agent's read-only `runtime-config` mount, which holds the
runtime control key.

## Back up and restore

Back up a stopped, consistent installation to encrypted storage outside the host.
Capture these together:

- The private deployment environment, image manifest, repository revision,
  Compose project name and overrides, any externally supplied encryption key and
  infrastructure secrets such as certificate or DNS token files.
- The complete `PLATFORM_DATA_DIRECTORY`: PostgreSQL, the object store, agent
  state, TLS material and, with runtime logs, ClickHouse and the Collector queue.
  The object store also holds the generated key that encrypts app secrets,
  workload identity signing keys and app OAuth connections.
- The named volumes `platform-state`, `edge-config`, `runtime-config`,
  `runtime-state` and, with automatic HTTPS, `acme`. Docker prefixes them with the
  project name, for example `app-platform_platform-state`.
- With [external services](/self-hosting/external-services), the external
  database and buckets from the same point in time.

### Create a backup

1. Stop incoming traffic at the proxy, pause new deployments and wait for running
   deployment jobs to finish. Record the organization ID, the active runtime
   version and the deployed app versions.
2. Stop the agent and management. Stop `runtime` gracefully; it has a 45-second
   shutdown period. With runtime logs, stop the Collector and ClickHouse. Then stop
   PostgreSQL and RustFS.
3. Archive the data directory and named volumes, preserving ownership and
   permissions, together with the configuration files listed above. Never run
   `docker compose down --volumes`.
4. Copy the encrypted archive off the host.
5. Start management through Compose, which starts storage, initialization and the
   runtime. Start runtime logs and the agent, then the proxy.
6. Check an existing database record and its associated file.

### Restore

On the existing host, stop the same services, restore the complete matching
snapshot and environment, and start with the recorded source and image versions.

On a replacement host, restore the same absolute data path, Compose project name,
named volumes and ownership before starting anything. The saved agent access key
in the private environment keeps the agent connected. Start management and its
dependencies, then runtime logs and the agent. Allow only the restore operator
through the proxy while you check sign-in, `widefleet runtime status`, an existing
app, a database record and its file. The restored runtime state and routes bring
back the installed deployments. Open general access after these checks pass.

Rules for every restore:

- Restore database, object store and runtime state from the same snapshot.
- Restore PostgreSQL together with its encryption key.
- Never copy live PostgreSQL data files.
- Never run the old and the restored runtime against the same storage at the same
  time.

Complete a restore drill with your actual storage and backup target before you
rely on the backup.
