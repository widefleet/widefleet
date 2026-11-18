---
title: Previews
description: Preview names, flags, isolation, addresses and cleanup.
lastModified: 2026-11-18
---

A preview runs your changes at their own address with their own data, next to the
published app. Deploy the parent app first, then run these commands from its project:

```sh
# Preview changes on a work branch.
git switch -c review
widefleet preview

# Choose a name when source storage is disabled or unavailable.
widefleet preview --name review
```

The command builds locally, creates or reuses the preview, uploads the build, waits
for activation and prints the server-provided URL. On a standard installation, a
preview named `review` for `notes.apps.example.com` is available at
`review.notes.apps.example.com`.

The parent app is resolved from `name` in `wrangler.jsonc` and the selected platform
URL; use `--app NAME_OR_UUID` to choose another. Previews cannot themselves be
preview parents. Failed builds do not create previews. A name belonging to an
unrelated app, a deleting app or a legacy preview at another hostname is rejected
before uploading code.

Self-hosted installations need DNS and a TLS certificate for these nested hostnames;
see [automatic HTTPS](/self-hosting/external-services#automatic-https-with-cloudflare).
With automatic HTTPS, the first preview of an app becomes reachable over HTTPS once
its certificate is issued, which can be shortly after the deployment succeeds.

## Own data and settings

Each preview starts with its own empty D1, R2, KV and Queue resources, separate
from the published app's data. Plain-text variables and resource
declarations come from the project configuration being deployed. Configure network
permissions and app connections separately for the preview's own app ID when needed.

Previews use the same sign-in as the app and always follow the original app's
access groups. Manage them on the original app, for example with
`widefleet access set --group GROUP_ID`. See [app access](/reference/app-access#previews).

## Names and repeated deployments

Explicit names contain 1–48 lowercase letters, digits or internal hyphens. Git branch names are converted to lowercase DNS labels; changed names receive a hash suffix so branches such as `feature/login` and `feature-login` remain distinct. Without source storage, a detached checkout or a project without Git needs an explicit `--name`.

Each preview has a stable app ID and an internal slug based on the parent slug and preview name. Long slugs are shortened with a hash suffix to fit the existing 48-character limit. This does not shorten the hostname. Deploying the same name again preserves its data and deployment history.

When Widefleet saves source code, each preview uses its own work branch in the
app's repository. The branch also determines the preview name; `--name` cannot
override it. Use a branch other than `main`, which belongs to the main app.

Switching branches selects that branch's preview. To update an existing preview
with `widefleet deploy PREVIEW_ID`, check out its branch first. For a CI checkout
without a local branch, pass `--source-branch BRANCH`.
See [source code](/guides/source-code) for saving and recovering preview code.

## Organization addresses

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
widefleet preview --json
widefleet history PREVIEW_UUID
widefleet delete PREVIEW_UUID --yes
```

Deleting an app also queues deletion of all its previews, including descendants created through the legacy `create --parent` workflow, which keep their flat hostnames. They immediately stop accepting deployments and new previews; the agent processes cleanup asynchronously. Deleting a preview leaves its parent and sibling previews intact. The [app removal cleanup](/reference/runtime#app-removal) also applies to previews.
