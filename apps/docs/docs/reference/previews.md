---
title: Previews
description: Preview names, flags, isolation, DNS and cleanup.
lastModified: 2026-10-20
---

Run these commands from an existing app project:

```sh
# Use the current Git branch as the preview name.
widefleet preview

# Choose a stable name explicitly, including in CI with a detached HEAD.
widefleet preview --name review
```

On a standard installation, for an app at `notes.apps.example.com`, the second command deploys to `review.notes.apps.example.com`. The app is resolved from `name` in `wrangler.jsonc` and the selected platform URL. It must already be registered; a preview never creates or deploys the parent app. Use `--app NAME_OR_UUID` to choose another parent. Previews cannot themselves be preview parents.

The command builds locally, creates or reuses the preview, uploads the build, waits for activation and prints the server-provided URL. Failed builds do not create previews. A name belonging to an unrelated app, a deleting app or a legacy preview at another hostname is rejected before uploading code.

## Names and repeated deployments

Explicit names contain 1–48 lowercase letters, digits or internal hyphens. Git branch names are converted to lowercase DNS labels; changed names receive a hash suffix so branches such as `feature/login` and `feature-login` remain distinct. Without Git or on a detached HEAD, pass `--name` explicitly.

Each preview has a stable app ID and an internal slug based on the parent slug and preview name. Long slugs are shortened with a hash suffix to fit the existing 48-character limit. This does not shorten the hostname. Deploying the same name again preserves its data and deployment history.

Manage access groups on the original app with `widefleet access set --group GROUP_ID`. Its previews inherit the rule and all later changes automatically. See [app access](/reference/app-access).

Previews start with their own empty D1, R2, KV and Queue resources. Plain-text variables and resource declarations come from the project configuration being deployed. Configure network permissions and connector bindings separately for the preview's own app ID when needed.

## Organization addresses

This section describes unreleased organization hostname suffixes and requires matching
CLI and control-plane builds containing that capability.

An installation can assign a stable hostname suffix to an organization. With suffix `acme`
and `APP_DOMAIN=apps.example.com`, an app named `notes` has address
`notes-acme.apps.example.com`; its named preview `review` has address
`review-notes-acme.apps.example.com`. Both use one label below the shared app domain,
so its `*.apps.example.com` certificate covers both. Renaming the organization does
not change the stored organization suffix.

The combined app or preview label must fit the DNS limit of 63 characters. If the
server rejects an address as too long, choose a shorter app or preview name.
Different combinations of names can produce the same complete hostname; the
server rejects an occupied hostname instead of assigning another app's address.
Use the URL returned by the server or CLI.

## Flags and cleanup

`--config PATH`, `--skip-build`, `--no-wait` and `--json` have the same meaning as with `widefleet deploy`. JSON output includes the preview's `appId`, deployment status and URL. Build and progress logs go to stderr. With `--no-wait`, the result reports the queued deployment; activation follows asynchronously.

```sh
widefleet preview --name review --json
widefleet history PREVIEW_UUID
widefleet delete PREVIEW_UUID --yes
```

Deleting an app also queues deletion of all its previews, including descendants created through the legacy `create --parent` workflow. They immediately stop accepting deployments and new previews; the agent processes cleanup asynchronously. Deleting a preview leaves its parent and sibling previews intact. The [resource cleanup limits](/reference/runtime#app-removal) also apply to previews.

## DNS, HTTPS and upgrades

Update the CLI, control plane, agent and generated edge configuration together before using this command. Existing apps and previews keep their hostnames; the manual `create --parent` workflow remains supported with its existing flat hostname.

With the versioned `compose.acme-cloudflare.yaml` overlay, Traefik automatically requests and renews one wildcard certificate per parent app when a nested preview is first deployed. For example, `review.notes.apps.example.com` and `other.notes.apps.example.com` share `*.notes.apps.example.com`. The agent receives `TLS_MODE=cloudflare` and `APP_DOMAIN` through Compose and writes the certificate request into the preview's persistent route. Only Traefik receives the DNS token. Certificate state remains in the existing ACME volume across restarts.

The existing `*.apps.example.com` DNS wildcard can resolve deeper preview names when no closer DNS record overrides it. If there are explicit records at `notes.apps.example.com`, also configure `*.notes.apps.example.com` to reach the same proxy. A TLS wildcard covers only one label: `*.apps.example.com` alone does not cover `review.notes.apps.example.com`.

When using `TLS_MODE=provided`, supply a certificate covering the preview hostname or its parent wildcard as well as the existing app and management hosts. Automatic certificate issuance is available through the Cloudflare ACME overlay. Follow the [versioned DNS and TLS setup](/self-hosting/external-services#automatic-https-with-cloudflare) and the installation's normal deployment process.

Initial certificate issuance is asynchronous. A successful app deployment confirms runtime activation and route publication; HTTPS may remain unavailable until Traefik has issued the first certificate. Check Traefik logs if issuance fails. Nested previews use the same SSO and credential-stripping middleware as regular apps.
