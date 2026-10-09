# CLI release publishing

Publishing a stable GitHub Release in `widefleet/widefleet` starts **Publish CLI to npm**. The workflow publishes the `widefleet` package to `https://registry.npmjs.org`. Installation and app development are documented in the [user guide](https://widefleet.com/docs/getting-started/installation).

## Configure npm publishing

In the npm package's **Settings → Trusted Publisher**, add GitHub Actions with:

- Organization: `widefleet`
- Repository: `widefleet`
- Workflow filename: `publish-cli.yaml`
- Environment: leave empty
- Allowed action: `npm publish`

The publishing job uses OpenID Connect and has `id-token: write`. It does not need an `NPM_TOKEN` or a GitHub Packages token. npm generates provenance for the public repository and package. See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).

## Publish a version

1. Update `package.json` and the Cargo workspace version together and merge the change into `main`.
2. In GitHub Releases, create a stable release with tag `vVERSION`, targeting that commit on `main`, and publish it. For example, version `0.3.0` uses `v0.3.0`.
3. Wait for **Publish CLI to npm** to succeed. Publishing the GitHub Release starts the build; it does not mean the npm package is available yet.
4. Verify `pnpm add --global widefleet@VERSION --registry=https://registry.npmjs.org` and `widefleet --version` on Linux x64 with glibc.

Ordinary pushes to `main`, tag pushes, drafts and prereleases do not publish packages. Tags outside the `vMAJOR.MINOR.PATCH` format are rejected. Both project versions must match the tag, and its commit must be reachable from `main`.

The workflow builds the CLI and agent in the pinned Debian toolchain, bundles esbuild and the starter, and installs the resulting npm archive in isolation for a real deployment test against local services. Only the tested archive is passed to the publishing job. Publication checks its checksum and package destination, then verifies the npm integrity hash and a fresh registry installation.

Rerun a failed workflow, or run it manually from `main` with the existing published release tag. An existing npm version is accepted only when its bytes and repository metadata match; it is never overwritten. Changed bytes require a new version and release. The manual workflow also retains `verify_only`, which checks an existing npm version without publishing a missing version.

The tested npm archive, manual archive and checksums are attached to the same GitHub Release. Existing attachments are downloaded and compared before a retry proceeds; they are never overwritten. Actions artifacts are used only to transport the tested files between jobs.

## Build a release locally

Maintainers need the repository's pinned Node, pnpm and Rust toolchains:

```sh
pnpm install --frozen-lockfile
pnpm package:cli
```

The command creates `widefleet-VERSION.tgz`, `widefleet-cli-VERSION-linux-x64.tar.gz` and their SHA-256 files under `.local/releases`. It refuses to overwrite an existing output directory and normalizes archive timestamps and ownership. The package includes the MIT license and the starter's hidden files and independent lockfile.

To package an existing binary, pass `--binary PATH --output DIRECTORY`. Run the deployment suite with `CLI_NPM_PACKAGE=/absolute/path/to/widefleet-VERSION.tgz RUN_RUNTIME_TESTS=1 pnpm exec vitest run apps/control-plane/tests/runtime/deployment.test.ts`. The suite also accepts `CLI_RELEASE_ARCHIVE` for the manual archive installation. These tests use local services and synthetic accounts.
