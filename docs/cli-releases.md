# CLI release publishing

Build, test and publish the bundled CLI from this repository. Installation and app development are documented in the [user guide](https://widefleet.com/docs/getting-started/installation).

## Build a release from source

Maintainers need the repository's pinned Node, pnpm and Rust toolchains:

```sh
pnpm install --frozen-lockfile
pnpm package:cli
```

The command builds the release CLI and creates the archive and SHA-256 file under `.local/releases`. It refuses to overwrite an existing release directory. Tests can pass `--binary target/debug/widefleet --output /tmp/a-new-release-directory` to package an already built binary. Release artifacts must be tested outside this workspace before publishing.

The same command also creates `getmendra-widefleet-VERSION.tgz` and its SHA-256 file for pnpm. This npm-compatible archive preserves the starter's hidden files and independent lockfile. Run the deployment suite with `CLI_NPM_PACKAGE=/absolute/path/to/getmendra-widefleet-VERSION.tgz RUN_RUNTIME_TESTS=1 pnpm exec vitest run apps/control-plane/tests/runtime/deployment.test.ts` to exercise an isolated global pnpm installation through a real deployment. The suite also accepts `CLI_RELEASE_ARCHIVE` for the manual archive installation.

## Public npm release target

The public repository is `widefleet/widefleet`; the CLI package is `@widefleet/widefleet` on `https://registry.npmjs.org`, with public access. Installation requires no registry token. Before the first public release, migrate `tools/package-cli.ts` and `.github/workflows/publish-cli.yaml` together: package scope and archive filename, source URL, registry, publication authentication, visibility checks and registry installation verification. Configure the npm organization and the workflow's publishing identity before publishing a new version.

The implementation below describes the existing GitHub Packages pipeline, which still needs that migration. Do not use it to publish the public npm package.

## Existing GitHub Packages pipeline

Attach the tested `.tgz` and its checksum to the matching `vVERSION` GitHub release. Run the repository's **Publish CLI package** workflow manually with that version, without the `v` prefix. The workflow downloads and verifies the release asset, checks installation, publishes through `GITHUB_TOKEN` with `packages: write`, checks private/internal visibility and the registry manifest's repository, and verifies installation from the registry.

Repository linking and access inheritance are checked in GitHub Package Settings: the REST API's repository field is optional and nullable, so its absence does not establish that a package is unlinked. If the settings show an unlinked package, open the existing package page, choose **Connect repository** and select `widefleet`. In Package Settings, enable **Inherit access from repository**. Rerun the workflow with `verify_only` enabled: this checks the existing package without attempting to publish the same version again. Registry verification compares the downloaded package's integrity with the tested release artifact before running it.

The package manifest pins the publication registry to `https://npm.pkg.github.com` with restricted access. New GitHub Packages default to private visibility. The workflow refuses to publish to an existing public package, one whose registry manifest names another repository, or one whose API response explicitly links another repository. Existing package versions are immutable; create a new release version for changes. No personal publishing token is stored in the repository.
