# Runtime release publishing

Build and publish the JavaScript app runtime from this repository. Operator update and rollback instructions live in the [runtime guide](https://widefleet.com/docs/reference/runtime).

The release workflow builds and tests `packages/app-runtime`, then publishes `release.json` and its checksum when a matching `runtime-v*` tag is pushed. Change the package version before publishing different bytes. Generated bundles stay outside Git and are never embedded in the agent binary.

Before the first public release from `widefleet/widefleet`, update the release-download repository in `crates/platform-cli/src/runtime.rs`. Rebuild and test the CLI against the new release location; older binaries retain their compiled download URL.
