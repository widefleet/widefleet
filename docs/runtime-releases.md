# Runtime release publishing

Build and publish the JavaScript app runtime from this repository. Operator update and rollback instructions live in the [runtime guide](https://widefleet.com/docs/reference/runtime).

The **Publish app runtime** workflow retains its independent release flow:

1. Update the version in `packages/app-runtime/package.json` and merge the change into `main`.
2. Push the matching `runtime-vVERSION` tag on that commit. This is separate from the platform's `vVERSION` release used for npm and Docker Hub publication.
3. The workflow checks the tag's version and ancestry on `main`, builds the runtime, runs source checks and tests its native capabilities against the pinned celld.
4. After the checks pass, it creates a GitHub Release with `release.json` and its checksum. The runtime release is not marked as the latest platform release.

The workflow can also be run manually from `main` for an existing runtime tag. It refuses to replace an existing release. Change the runtime package version before publishing different bytes. Generated bundles stay outside Git and are never embedded in the agent binary.

The CLI downloads these assets from `widefleet/widefleet`. Older CLI binaries retain their compiled release-download URL and must be updated before they can use this repository's runtime releases.
