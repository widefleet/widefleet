# CLI release publishing

Pushing a stable `vVERSION` tag to `widefleet/widefleet` starts **Publish Widefleet**. The workflow prepares a draft GitHub Release, builds and tests the CLI and images, publishes to npm and Docker Hub, and publishes the completed GitHub Release last. The npm package is `widefleet` at `https://registry.npmjs.org`. Installation and app development are documented in the [user guide](https://widefleet.com/docs/getting-started/installation).

## Configure npm publishing

In the npm package's **Settings → Trusted Publisher**, add GitHub Actions with:

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

3. Wait for **Publish Widefleet** to succeed. It creates a draft with generated release notes, or preserves an existing draft and its notes. Both the CLI deployment tests and packaged image tests must pass before either registry publication starts. The GitHub Release becomes public only after both registry publications and all six attachment verifications succeed; do not publish the draft manually.
4. Verify `pnpm add --global widefleet@VERSION --registry=https://registry.npmjs.org` and `widefleet --version` on Linux x64 with glibc. The completed GitHub Release contains the CLI archives, image digest manifest and checksums.

Ordinary pushes to `main` and GitHub Release events do not publish packages. Tags outside the `vMAJOR.MINOR.PATCH` format are rejected. Both project versions must match the tag, and its commit must be reachable from `main`. An existing published release is rejected during preparation.

The workflow builds the CLI and agent in the pinned Debian toolchain, bundles esbuild and the starter, and installs the resulting npm archive in isolation for a real deployment test against local services. Only the tested archive is passed to the publishing job. Publication checks its checksum and package destination, then verifies the npm integrity hash and a fresh registry installation.

To recover from a failure, use **Re-run failed jobs** on the original GitHub Actions run. The workflow checks out the commit that triggered that run, keeping npm provenance tied to the tested source even if `main` has advanced. An existing npm version is accepted only when its bytes and repository metadata match; it is never overwritten. Changed bytes require a new version and release.

The tested npm archive, manual archive and checksums are attached to the draft alongside the image manifest after both registry jobs succeed. Existing attachments are downloaded and compared before a retry proceeds; they are never overwritten. Actions artifacts are used only to transport the tested files between jobs. A failed run leaves the GitHub Release in draft, although a registry may already contain some artifacts; publication across GitHub, npm and Docker Hub is not atomic. If the final publication succeeds but its response is lost, rerunning the failed job verifies the completed release without modifying its assets.

## Build a release locally

Maintainers need the repository's pinned Node, pnpm and Rust toolchains:

```sh
pnpm install --frozen-lockfile
pnpm package:cli
```

The command creates `widefleet-VERSION.tgz`, `widefleet-cli-VERSION-linux-x64.tar.gz` and their SHA-256 files under `.local/releases`. It refuses to overwrite an existing output directory and normalizes archive timestamps and ownership. The package includes the MIT license and the starter's hidden files and independent lockfile.

To package an existing binary, pass `--binary PATH --output DIRECTORY`. Run the deployment suite with `CLI_NPM_PACKAGE=/absolute/path/to/widefleet-VERSION.tgz RUN_RUNTIME_TESTS=1 pnpm exec vitest run apps/control-plane/tests/runtime/deployment.test.ts`. The suite also accepts `CLI_RELEASE_ARCHIVE` for the manual archive installation. These tests use local services and synthetic accounts.
