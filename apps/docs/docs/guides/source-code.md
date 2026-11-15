---
title: Save and recover source code
description: Save an app's code in Git and continue working from another session or machine.
lastModified: 2026-11-15
---

Use Widefleet Cloud's app repositories to keep source code available to people,
agents and CI. Install Git and the Widefleet CLI, sign in and select your
organization. You need management access to the app. Self-hosted installations
can continue using their existing Git provider; they do not provide app repositories.

## Save a deployment's source

From your app's project, run:

```sh
widefleet deploy
widefleet source status
```

The CLI builds locally, commits changed project files and pushes the commit before
uploading the deployment. If the checkout is already clean, it uses the existing
commit. A failed source save stops the deployment. The CLI checks project files
before and after the build; changes during the build stop the deployment so its
source reference cannot describe a different version. Review those changes and
deploy again. If a commit hook or signing fails, the previous staging selection
is restored.

File selection follows Git and `.gitignore`. Tracked files remain tracked even
when an ignore rule matches them. Widefleet adds no extra file exclusions.
Changes are committed on your current local branch. Outside an existing Git
repository, the CLI initializes one in the project directory. Inside a monorepo,
it saves the repository and records the app's relative directory.

The main app initially uses the remote `main` branch. To choose another branch,
use `widefleet deploy --source-branch BRANCH`. That choice applies to subsequent deployments of the app.

If your local branch differs from the target branch, the CLI asks before building,
committing or pushing. For example, deploying from local `feature` to remote
`main` updates `main` in Widefleet Git and publishes that code as the main app.
Press Enter to cancel. Switch to the intended branch, or explicitly confirm the
exception for this invocation:

```sh
widefleet deploy --allow-branch-mismatch
```

Agents and CI must use this flag for a branch mismatch or a detached checkout;
noninteractive commands otherwise stop without building. The confirmation does
not change the app's selected branch or permit a force-push. Git previews still
require their own matching work branch.

`widefleet source status` reports the repository URL, selected branch and latest
saved commit. Its `deployed` field identifies the active deployment's source,
which can differ from the latest saved commit. The Source tab shows the same
information.

## Continue in another session

Find the app with `widefleet apps`. Its `source.available` field tells an agent
whether the selected branch contains saved code. Clone that code before editing
the existing app:

```sh
widefleet source clone APP_UUID my-app
cd my-app
widefleet source status --app APP_UUID
```

Replace `APP_UUID` with the app's ID. The clone uses the app's selected branch and
sets up a `widefleet` remote authenticated through your Widefleet login. For a
monorepo, enter the project directory shown in the source status before deploying.
Use `--read-only` with the clone command when your CLI token has only
`platform:read` scope.

An existing repository can still be empty. If `source.available` is false, inspect
`source.error` first: when Git is unavailable, retry instead of treating the app
as empty. Otherwise inspect `source.repository` and the selected branch before
creating new code. A null `source.deployed` means the active deployment has no
saved source reference.

## Use normal Git commands

Connect an existing checkout to an app that already exists:

```sh
widefleet source connect --app APP_UUID
git add .
git commit -m "Update the app"
git push widefleet HEAD:main
```

The command adds a `widefleet` remote and preserves existing remotes such as
GitHub or GitLab's `origin`. Choose `--remote NAME` if that name is already in use.
Use your selected branch instead of `main` when appropriate.

A push saves code. Run `widefleet deploy` separately to publish it. To deploy a
specific checked-out commit from CI, use:

```sh
widefleet deploy --commit "$(git rev-parse HEAD)" --json
```

The checkout must match that commit with no uncommitted project changes. The JSON
result includes the source commit, branch and project directory. Use
`widefleet deploy --no-source` when keeping source exclusively in another Git
provider; that deployment has no Widefleet source reference.

If a source save reports newer remote changes, commit your local work, then fetch
and merge the selected branch before deploying again. In a connected checkout
using `main`:

```sh
git fetch widefleet
git merge widefleet/main
widefleet deploy
```

Resolve any merge conflicts locally. Automatic source saving never force-pushes.

## Keep preview work separate

Switch to a work branch before saving a preview's source. `widefleet preview` rejects the
main app's source branch before building. Direct deployments to an existing
preview also reject that branch before committing.

```sh
git switch -c feature/review
widefleet preview
```

The preview saves code to the same `feature/review` branch in the main app's
repository. Widefleet derives a URL-safe preview name from the branch. Repeated
deployments from that branch update the same preview; another branch gets its
own preview. The branch assignment is fixed.

For a detached CI checkout, use `widefleet preview --source-branch feature/review`.
The branch must differ from the main app's branch. With a local branch checked
out, an explicit source branch must match it.

Previews without source storage remain freely nameable with `--name NAME`.

Deleting a preview keeps its branch. Deleting the main app removes its managed
repository and all its branches; the deletion confirmation states this. External
GitHub and GitLab repositories are unaffected.

Once the source status shows the saved commit, another authorized session can
clone it and continue. See [deployments](/guides/deployments) for activation,
failure recovery and rollback.
