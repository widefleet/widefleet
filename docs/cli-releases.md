# CLI release publishing

Publish the CLI, platform images and app runtime from a checked commit on `main`. Pushing a stable `vVERSION` tag starts [Check and publish Widefleet](../.github/workflows/publish-cli.yaml), which publishes to npm and Docker Hub before making the completed GitHub Release public. Configure the npm and GitHub destinations below and [Docker Hub publishing](container-releases.md#configure-docker-hub-publishing) first. App creators use the [installation guide](https://widefleet.com/docs/getting-started/installation).

## Configure npm publishing

Configure **Settings → Trusted Publisher** on all five public npm packages before
tagging the first cross-platform release:

- `widefleet` — shared launcher
- `widefleet-linux-x64-gnu`
- `widefleet-darwin-arm64`
- `widefleet-darwin-x64`
- `widefleet-win32-x64-msvc`

Each native package is a separate npm destination with its own ownership and
publisher settings. Provision any missing packages under the release maintainers'
control first; the release workflow does not configure npm accounts or package
permissions. Use the same GitHub Actions trusted publisher on each package:

- Organization: `widefleet`
- Repository: `widefleet`
- Workflow filename: `publish-cli.yaml`
- Environment: leave empty
- Allowed action: `npm publish`

The publishing job uses OpenID Connect and has `id-token: write`. It does not need an `NPM_TOKEN` or a GitHub Packages token. npm generates provenance for the public repository and package. See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).

## Configure GitHub Releases

Enable **Settings → General → Releases → Enable release immutability**. All downloads are uploaded and verified while the release is a draft. Publishing then locks its assets and tag. See [GitHub release immutability](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases).

## Publish a version

1. Update the root `package.json` and the Cargo workspace version together and merge the change into `main`. The app runtime build reads that same root product version.
2. Push a stable `vVERSION` tag pointing to that commit on `main`. For example, version `0.3.0` uses `v0.3.0`. Replace `VERSION` and `COMMIT_SHA` below with the version and the checked commit:

   ```sh
   git fetch origin main
   git tag -a vVERSION COMMIT_SHA -m "Widefleet vVERSION"
   git push origin refs/tags/vVERSION
   ```

3. Wait for **Check and publish Widefleet** to succeed. It creates a draft with generated release notes, or preserves an existing draft and its notes. All four native CLI targets, the Linux deployment tests and packaged image tests must pass before either registry publication starts. The GitHub Release becomes public only after both registry publications and every attachment verification succeed; do not publish the draft manually.
4. Verify `pnpm add --global widefleet@VERSION` and `widefleet --version` on a supported host. pnpm installs the matching exact-version optional native package, including with install scripts disabled. The completed GitHub Release contains five npm archives, four standalone CLI archives, the image digest manifest, the app runtime `release.json` and their checksums. The runtime download must match the package in both the tested runtime and control-plane images; it is attached before the release becomes public.

Pushes to `main` publish CLI canaries as described below. GitHub Release events do not publish packages. Tags outside the `vMAJOR.MINOR.PATCH` format are rejected. Both project versions must match the tag, and its commit must be reachable from `main`. An existing published release is rejected during preparation.

Native packages must be available before the shared launcher, because it selects an exact-version optional dependency. The publisher waits for npm metadata and tarball availability instead of treating upload acceptance as completed publication. Changing the [publication code](../tools/publish-cli.sh) must preserve that ordering and verify the tested bytes.

## Use automatic CLI canaries

Pushes to `main`, including merged pull requests, start a CLI-only publication in **Check and publish Widefleet** when they change CLI package inputs or its build and publication tooling. These include the CLI and shared Rust core, bundled starters and launcher, and the installation guide copied into the package README. Shared lockfiles and build configuration conservatively trigger publication too. The [CLI input list](../.github/cli-inputs.json) defines the inputs; keep it aligned when adding packaging inputs or local CLI dependencies.

Control-plane, runtime, website and test-only changes outside those inputs do not publish a canary. PRs run **Check**; main pushes run the same CLI compatibility tests and service suites in **Check and publish Widefleet**. Stable version tags continue to run the full release pipeline. All four native targets are built and tested before canary publication. The existing npm trusted publisher configuration above also authorizes this path; no additional token or workflow registration is needed.

On `main`, the native CLI matrix runs once. Publication downloads its tested artifacts from the same workflow run and waits for every selected check to succeed. Service changes run compatibility tests without publishing a canary. Packaged Markdown changes run the native matrix without the service suites; unrelated documentation needs only the lightweight selection and status jobs. Missing comparison history conservatively selects all checks and publication. Main checks now share publication's non-cancelling queue; PR checks still cancel superseded runs.

Each build uses `BASE-canary.RUN.gSHA`, where `BASE` is the product version, `RUN` is the workflow run number and `SHA` is the first twelve commit characters. The version is stamped only in the build checkout. The binary, launcher and native packages use the same version, without committing a version bump to `main`.

Opt in to the newest successful main build:

```sh
npx widefleet@canary --version
pnpm add --global widefleet@canary
```

For a reproducible installation, replace `canary` with the complete version shown by the workflow. Return to the stable channel with:

```sh
pnpm add --global widefleet@latest
```

Canary publication updates only the `canary` npm dist-tag on the five CLI packages. Normal installs and `@latest` continue selecting stable releases. Canary builds do not publish platform images, app runtimes or GitHub Releases.

Main publication runs queue instead of canceling earlier pending builds. For a partial failure, use **Re-run failed jobs** on the original run to reuse its version and tested artifacts. A retry refuses to move `canary` behind an already published newer run; use the newer canary in that case. Check the workflow summary and `npx widefleet@canary --version` after publication succeeds.

## Retry a partial publication

Publication across GitHub, npm and Docker Hub is not atomic. A failed run can leave some registry artifacts published while the GitHub Release remains in draft. Do not publish the draft manually, move the tag or replace an existing version.

Resolve the underlying failure, then use **Re-run failed jobs** on the original GitHub Actions run. The workflow uses that run's source commit even if `main` has advanced, keeping provenance tied to the tested source. Existing npm versions and release attachments must match exactly; different bytes require a new version.

If npm accepts an upload but the package is not yet installable, the publisher retries availability checks for up to two hours per package without repeating `npm publish`. An availability timeout can be retried with the same run. Mismatched bytes, repository metadata and authorization errors fail immediately and need investigation. For partially published images, follow [container recovery](container-releases.md#retry-a-partial-publication).

The [final publication step](../tools/publish-github-release.sh) verifies downloads before publishing the draft. If publication succeeds but its response is lost, rerunning the failed job verifies the completed release without modifying its assets.

After publication, review dependent documentation using the [documentation release rules](../AGENTS.md#documentation-pull-requests-and-releases).

## Build a release locally

Maintainers need the repository's pinned Node, pnpm and Rust toolchains:

```sh
pnpm install --frozen-lockfile
pnpm package:cli
```

The command creates the launcher `widefleet-VERSION.tgz`, one native npm archive,
one standalone archive, and their SHA-256 files under `.local/releases`:

| Host                | Native npm archive                     | Standalone archive suffix |
| ------------------- | -------------------------------------- | ------------------------- |
| Linux x64, glibc    | `widefleet-linux-x64-gnu-VERSION.tgz`  | `linux-x64`               |
| macOS Apple Silicon | `widefleet-darwin-arm64-VERSION.tgz`   | `darwin-arm64`            |
| macOS Intel         | `widefleet-darwin-x64-VERSION.tgz`     | `darwin-x64`              |
| Windows x64         | `widefleet-win32-x64-msvc-VERSION.tgz` | `win32-x64`               |

Standalone files are named `widefleet-cli-VERSION-SUFFIX.tar.gz`. Packaging refuses
to replace existing output; use a fresh output directory for a rebuild. Keep the
starter's hidden configuration and independent lockfile in packaged fixtures.
The release uses the Linux-built launcher for all hosts.

To package an existing native binary, pass `--binary PATH --output DIRECTORY`.
Run the package suite with `RUN_CLI_PACKAGE_TESTS=1 pnpm test:cli-package`; set
`CLI_PACKAGE_DIR` when using another output directory. The required **Check**
workflow runs the native suite on all four hosts. Windows console Ctrl+C still
requires an interactive check because Node's signal API does not deliver a console
event.

Run the Linux deployment suite with `CLI_NPM_PACKAGE=/absolute/path/to/widefleet-VERSION.tgz RUN_RUNTIME_TESTS=1 pnpm exec vitest run apps/control-plane/tests/runtime/deployment.test.ts`. Keep the matching Linux native archive and both checksums beside the launcher archive. The suite serves these files from a disposable local registry; it never substitutes a published npm version. It also accepts `CLI_RELEASE_ARCHIVE` for the manual archive installation. These tests use local services and synthetic accounts.
