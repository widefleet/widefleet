# CLI release publishing

Pushing a stable `vVERSION` tag to `widefleet/widefleet` starts **Publish Widefleet**. The workflow prepares a draft GitHub Release, builds and tests the CLI and images, publishes to npm and Docker Hub, and publishes the completed GitHub Release last. The npm package is `widefleet` at `https://registry.npmjs.org`. Installation and app development are documented in the [user guide](https://widefleet.com/docs/getting-started/installation).

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

Enable **Settings → General → Releases → Enable release immutability** after the release workflows are on `main`. All downloads are uploaded and verified while the release is a draft. Publishing then locks its assets and tag. See [GitHub release immutability](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases).

## Publish a version

1. Update `package.json` and the Cargo workspace version together and merge the change into `main`.
2. Push a stable `vVERSION` tag pointing to that commit on `main`. For example, version `0.3.0` uses `v0.3.0`. Replace `VERSION` and `COMMIT_SHA` below with the version and the checked commit:

   ```sh
   git fetch origin main
   git tag -a vVERSION COMMIT_SHA -m "Widefleet vVERSION"
   git push origin refs/tags/vVERSION
   ```

3. Wait for **Publish Widefleet** to succeed. It creates a draft with generated release notes, or preserves an existing draft and its notes. All four native CLI targets, the Linux deployment tests and packaged image tests must pass before either registry publication starts. The GitHub Release becomes public only after both registry publications and every attachment verification succeed; do not publish the draft manually.
4. Verify `pnpm add --global widefleet@VERSION --registry=https://registry.npmjs.org` and `widefleet --version` on a supported host. pnpm installs the matching exact-version optional native package, including with install scripts disabled. The completed GitHub Release contains five npm archives, four standalone CLI archives, the image digest manifest and their checksums.

Ordinary pushes to `main` and GitHub Release events do not publish packages. Tags outside the `vMAJOR.MINOR.PATCH` format are rejected. Both project versions must match the tag, and its commit must be reachable from `main`. An existing published release is rejected during preparation.

The Linux release job continues to build the CLI and agent in the pinned Debian toolchain. A reusable native workflow builds macOS Apple Silicon, macOS Intel and Windows x64 on matching hosts. Each native package bundles the matching esbuild executable, starter and licenses. Native tests cover CLI operations, macOS/Windows saved logins and concurrent refresh, and package installation from a disposable local registry. The package tests build a generated app and upload it to a local API fixture. Linux/macOS also test launcher signal forwarding and child cleanup; Windows console Ctrl+C requires an interactive check because Node's signal API does not deliver a console event.

The Linux release job additionally installs the launcher and its native dependency from the exact local archives for the real deployment suite. Only tested artifacts are passed to publication. The publisher checks every archive and existing immutable version before its first publish, publishes the four native dependencies before the launcher, and verifies npm integrity, repository metadata and a fresh registry installation. npm trusted publishing and provenance remain in `publish-cli.yaml`.

To recover from a failure, use **Re-run failed jobs** on the original GitHub Actions run. The workflow checks out the commit that triggered that run, keeping npm provenance tied to the tested source even if `main` has advanced. An existing npm version is accepted only when its bytes and repository metadata match; it is never overwritten. Changed bytes require a new version and release.

All tested npm archives, standalone archives and checksums are attached to the draft alongside the image manifest after both registry jobs succeed. Existing attachments are downloaded and compared before a retry proceeds; they are never overwritten. Actions artifacts are used only to transport the tested files between jobs. A failed run leaves the GitHub Release in draft, although a registry may already contain some artifacts; publication across GitHub, npm and Docker Hub is not atomic. If the final publication succeeds but its response is lost, rerunning the failed job verifies the completed release without modifying its assets.

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
to replace existing output and normalizes archive timestamps and ownership on
Linux. Packages preserve the starter's hidden configuration, line-ending policy
and independent lockfile. The release uses the Linux-built launcher for all hosts.

To package an existing native binary, pass `--binary PATH --output DIRECTORY`.
Run the package suite with `RUN_CLI_PACKAGE_TESTS=1 pnpm test:cli-package`; set
`CLI_PACKAGE_DIR` when using another output directory. The required **Check**
workflow runs the native suite on all four hosts.

Run the Linux deployment suite with `CLI_NPM_PACKAGE=/absolute/path/to/widefleet-VERSION.tgz RUN_RUNTIME_TESTS=1 pnpm exec vitest run apps/control-plane/tests/runtime/deployment.test.ts`. Keep the matching Linux native archive and both checksums beside the launcher archive. The suite serves these files from a disposable local registry; it never substitutes a published npm version. It also accepts `CLI_RELEASE_ARCHIVE` for the manual archive installation. These tests use local services and synthetic accounts.
