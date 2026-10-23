# Runtime release publishing

The JavaScript app runtime uses the product version from the root `package.json`. Publish it through the [platform release procedure](cli-releases.md#publish-a-version); there is no separate runtime tag or publication workflow.

The packaged-image tests extract `release.json` from the runtime image and compare its bytes with the source build and the control-plane image. The platform release attaches this tested package and `release.json.sha256` alongside the CLI downloads and image manifest. Missing artifacts, mismatched versions or different bytes prevent final publication. Retries reuse the tested artifacts.

Runtime activation remains independent of container rollout, subject to the runtime protocol and celld compatibility checks. Operator update and rollback instructions live in the [runtime guide](https://widefleet.com/docs/reference/runtime).
