# Container release publishing

Build, test and publish Widefleet container images from this repository. Operators use the [installation guide](https://widefleet.com/docs/self-hosting/installation#pull-the-release-images) to select and verify published images.

## Public release target

The public repository is `widefleet/widefleet`. Publish all four `widefleet-*` images under `ghcr.io/widefleet` with public visibility so operators can pull without authentication. A public repository does not by itself make an existing package public.

Before the first public release, update the release workflows' repository associations, GHCR destinations and private-only visibility checks; make the packages public and verify anonymous pulls for every digest in the release manifest. The workflow described below still enforces private destinations and must be migrated before following the public installation guide. Keep immutable tags, checksum verification and pre-publication tests intact.

## Publish

Commit the change and update the root package and Cargo workspace versions together. The local tools image selects the CLI path from the packaged binary's version. Push the matching `vVERSION` Git tag; this starts the workflow. It creates or resumes a **draft** release, attaches the checked digest manifest, then publishes the completed release. An existing draft can hold maintainer-written notes or other tested artifacts.

```sh
git tag vVERSION
git push origin vVERSION
```

Do not publish the GitHub release manually first: this repository enables immutable releases, so attachments cannot be added after publication. For tags pushed by automation using `GITHUB_TOKEN`, explicitly dispatch the workflow, because GitHub does not start another workflow from most events created with that token. A manual run accepts an existing tag version without the `v` prefix.

The workflow always checks out that tag, validates the source version and installs locked dependencies. It pins Docker Engine 29.8.1, matching the tested host baseline, instead of using the runner's preinstalled daemon. It uses its own `GITHUB_TOKEN`; no personal publishing secret is required.

Strict typing, formatting and lint run alongside three independent image builds: runtime/agent, control plane and SSO. Only the agent waits for the runtime image, which becomes its base. Images move between jobs as workflow artifacts; their image IDs and source/version labels are checked after loading. The shared test job also checks the selectable Compose configurations, credential isolation, verified PostgreSQL TLS/migrations and Traefik certificate loading across restarts. These installation fixtures do not contact cloud services or issue public certificates. Its isolated PostgreSQL/RustFS test:

1. Generates proxy configuration using the packaged tool.
2. Initializes a new database and buckets twice to verify repeatability.
3. Starts the actual control-plane image and verifies unauthenticated API rejection.
4. Registers a fixture agent, creates an app and uploads a Worker through the API.
5. Runs the actual agent image, verifies successful activation in the selected runtime image, requests the Worker, then deletes the app.

Only after source checks and packaged tests pass does a separate job receive package/release write permissions and push images. It loads the same artifacts, rechecks private destinations and existing version tags, then pulls each published digest and compares its image ID with the tested image. The digest manifest is attached to the draft only once all four pushes and private-visibility checks succeed. Publication is the last step; the workflow then downloads and verifies the completed release files. Image artifacts expire after three days; after expiry, rerun the entire workflow to recover or rebuild the images and retest them.

Release tags and manifest attachments are never overwritten. On a retry, existing images must match the requested source commit, version, platform and source label; the workflow retests and reuses those exact images, building only missing ones. This permits recovery after a partially completed publication without replacing an already published version. A changed image source needs a new release. A published release is accepted only when its manifest attachments already exist; a retry checks identical assets instead of trying to replace them.

GHCR packages default to private. The workflow refuses existing public or internal destinations and explicitly mismatched repository associations. OCI source labels associate images with this repository. If an organization disables automatic access inheritance, grant intended readers access in each package's settings. GitHub's nullable package API repository field does not independently verify inherited permissions. See GitHub's [container registry documentation](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry).

## Build caches

The **Check release images** workflow runs the same build and packaged tests on relevant pull requests and on pushes to `main`, without publishing images or releases. Only `main` has `cache-mode: write`; pull requests and releases use `cache-mode: read`. Tag runs can read the default branch's caches, so warming them on `main` allows reuse across release tags.

Docker layers use separate GitHub Actions cache scopes for each image, with the ordinary check caches as additional inputs. The agent also restores Cargo downloads and release build outputs. Compilation runs inside the agent Dockerfile's pinned Debian toolchain, then a BuildKit named context supplies those binaries to the unchanged final image stage. Source or package-version changes retain compatible dependency outputs; toolchain changes start a new cache. Cargo still checks the locked dependency graph and rebuilds changed inputs. Local Docker builds continue to compile the binaries in the Dockerfile itself.

The CLI has its own package workflow and can remain at a compatible earlier version; a container release does not require republishing an unchanged CLI. Follow the [operations guide](https://widefleet.com/docs/self-hosting/installation) to install or update a host deliberately.

## Local verification

Build the four images with unique local tags, then select them explicitly:

```sh
docker build -f infra/runtime/Dockerfile -t widefleet-runtime:test .
docker build --build-arg RUNTIME_IMAGE=widefleet-runtime:test -f infra/agent/Dockerfile -t widefleet-agent:test .
docker build -f infra/control-plane/Dockerfile -t widefleet-control-plane:test .
docker build -f infra/sso/Dockerfile -t widefleet-sso:test .
docker compose -f infra/test/compose.yaml up -d --wait
env PLATFORM_CONTROL_PLANE_IMAGE=widefleet-control-plane:test \
  PLATFORM_AGENT_IMAGE=widefleet-agent:test \
  PLATFORM_SSO_IMAGE=widefleet-sso:test \
  PLATFORM_RUNTIME_IMAGE=widefleet-runtime:test \
  RUN_IMAGE_TESTS=1 RUN_PACKAGED_EDGE_TESTS=1 pnpm exec vitest run \
  apps/control-plane/tests/runtime/container.test.ts apps/control-plane/tests/installation
docker compose -f infra/test/compose.yaml down
```

This test uses loopback port `25434`, separate random databases/buckets and a temporary state directory. It supports a local Unix Docker socket, including rootless Docker. The local demo still builds its own images with `./dev up`; it does not need GHCR credentials.
