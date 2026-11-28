---
title: Save and recover source code
description: Keep your app's code in Git and continue working from another session or machine.
lastModified: 2026-11-16
---

Widefleet keeps your app's source code so you or your agent can pick up where you
left off, even in a new workspace. Source storage is available on Widefleet Cloud.
Support for self-hosted installations is coming soon.

Install Git and the [Widefleet CLI](/getting-started/installation), sign in and
select your organization. You need management access to the app.

## Save your code

From your app's project, run:

```sh
widefleet deploy
widefleet source status
```

Deploying automatically commits your changes and pushes them to the app's Git
repository before publishing the app. If you have already committed everything,
Widefleet uses that commit. If saving fails, the deployment stops.

The commit includes all changes, not just files you have staged. File selection
follows Git and `.gitignore`, including Git's rules for files already tracked.
Widefleet creates commits on your current branch. It initializes Git if needed;
in a monorepo, it saves the whole repository and remembers the app's directory.

Open the app's **Source** tab or run `widefleet source status` to see where the
code is saved. Both show the latest saved commit and the commit used by the
running app. These can differ if you push code without deploying it.

## Continue in another session

Find your app and clone its code:

```sh
widefleet apps
widefleet source clone APP_UUID my-app
cd my-app
```

Replace `APP_UUID` with the app's ID. The clone includes the latest code on the
app's branch and sets up Git to use your Widefleet login. Install the project's
dependencies, then continue editing and deploying as usual.

For a monorepo, enter the app's project directory before deploying. You can find
that directory with `widefleet source status --app APP_UUID`.

## Work on a preview

Create a branch for your changes, then deploy a preview:

```sh
git switch -c feature/review
widefleet preview
```

Widefleet saves your code to `feature/review` in the app's repository and uses
that branch to name the preview. Deploying from the same branch updates the same
preview. Another branch gets its own preview.

A preview keeps its branch. To update it, check out that branch again. The main
app uses `main`, so preview deployments from `main` are rejected.

When you're ready to publish the changes to the main app:

```sh
git switch main
git merge feature/review
widefleet deploy
```

For CI checkouts without a local branch, pass the branch name explicitly:

```sh
widefleet preview --source-branch feature/review
```

Without Widefleet source storage, you can choose a preview name with `--name`.
See [previews](/reference/previews) for naming rules and other options.

## Use your existing Git workflow

You can keep using GitHub or GitLab. To also push and pull with Widefleet, connect
your local project to an app that already exists:

```sh
widefleet source connect --app APP_UUID
```

This adds a remote named `widefleet` and sets up authentication using your
Widefleet login. Existing remotes such as `origin` stay in place. If `widefleet`
already points elsewhere, choose another name with `--remote NAME`.

You can then use normal Git commands. For the main app, from your local `main`
branch:

```sh
git add .
git commit -m "Update the app"
git push widefleet main
```

Pushing saves the code. Run `widefleet deploy` when you want to publish it.
If you prefer to keep code only in your existing Git provider, deploy with
`widefleet deploy --no-source`.

## Deploy the main app from another branch

Normally, deploy the main app from `main`. If you deploy from another branch,
Widefleet asks you to confirm: it will update `main` in the app's repository and
publish that code as the main app. Press Enter to cancel.

If your repository has no local `main`, for example because `git init` named the
first branch `master`, rename it before deploying:

```sh
git branch -m main
```

To confirm this for a single command in an agent or CI session, use
`widefleet deploy --allow-branch-mismatch`. This also applies to checkouts without
a local branch. The flag does not bypass a preview's branch requirement or
allow overwriting newer remote commits.

## Resolve a failed save

If the remote branch has changes missing from your checkout, commit your local
work, then fetch and merge them. For a connected checkout on `main`:

```sh
git fetch widefleet
git merge widefleet/main
widefleet deploy
```

Resolve any merge conflicts before deploying again. Widefleet never force-pushes
when saving a deployment's source.

If project files change during the build, review those changes and deploy again.
Widefleet stops so the saved code and the build stay in sync. If a Git commit hook
or signing fails, fix the reported error and retry; your previous staging
selection is preserved.

If Git is temporarily unavailable, retry once it recovers. A failed status
request does not mean your saved code is gone.

## Delete an app or preview

Deleting a preview keeps its Git branch. Deleting the main app removes its
Widefleet repository and all branches. The deletion confirmation explains what
will be removed. Your GitHub and GitLab repositories are unaffected.

See [deployments](/guides/deployments) for publishing and rollback, or the
[CLI reference](/reference/cli#source-repositories) for command options and JSON output.
