# Container release publishing

Publishing a stable GitHub Release in `widefleet/widefleet` starts **Publish Docker Hub images**. It builds, tests and publishes four Linux amd64 images:

| Docker Hub repository               | Purpose                                         |
| ----------------------------------- | ----------------------------------------------- |
| `widefleet/widefleet-runtime`       | celld runtime                                   |
| `widefleet/widefleet-agent`         | Deployment agent and CLI                        |
| `widefleet/widefleet-control-plane` | Management server, API and initialization tools |
| `widefleet/widefleet-sso`           | OAuth2 Proxy and configuration supervisor       |

Operators use the [installation guide](https://widefleet.com/docs/self-hosting/installation#pull-the-release-images) to pull and pin the images.

## Configure Docker Hub publishing

Create all four repositories under the `widefleet` namespace with **Public** visibility. The publishing workflow checks every destination before its first push and refuses private repositories.

Add these GitHub Actions secrets to `widefleet/widefleet`:

- `DOCKERHUB_USERNAME`: the Docker Hub login identity that can publish to all four repositories.
- `DOCKERHUB_TOKEN`: that identity's Docker Hub access token with read/write access to the repositories.

Keep tokens in GitHub Actions secrets. Docker Hub credentials are provided only to the publishing job after tests pass. See [Docker access tokens](https://docs.docker.com/security/access-tokens/).

## Publish a version

1. Update `package.json` and the Cargo workspace version together and merge the change into `main`.
2. Publish a stable GitHub Release with tag `vVERSION` pointing to that commit. The same release starts [npm CLI publication](cli-releases.md).
3. Wait for **Publish Docker Hub images** to succeed. The published release entry alone does not confirm registry publication.

The workflow checks the release state, version and commit's ancestry on `main`. It calls the same reusable build workflow as the pull-request and main-branch image checks. The agent, control-plane and SSO builds run in parallel; the agent job first builds its runtime base. Main-branch checks populate the Cargo and image-layer caches, while pull requests and release builds can only restore them. Disposable PostgreSQL and RustFS services exercise installation, authentication, configuration, storage and a real packaged app deployment before any image is pushed.

The publishing job downloads the tested images, verifies their image IDs and source/version labels, and pushes only missing version tags. It then pulls each digest anonymously and checks it against the tested image ID. The resulting `widefleet-images-VERSION.env` digest manifest and its checksum are attached to the same GitHub Release and verified by downloading them again. Existing attachments must match exactly and are never overwritten. Actions artifacts only transport the tested images between jobs.

Images use exact version tags and source commit labels. There is no floating `latest` tag and no update to running installations. Published version tags are never replaced by the workflow. Enable Docker Hub tag immutability for the version tags as an additional registry control if available for your account.

## Retry a partial publication

Rerun the failed workflow or dispatch it manually from `main`, supplying the existing published GitHub Release tag. Existing images must match the release's source commit, version, platform and source URL. They are pulled and retested with any missing images. This lets a retry finish a partial push without rebuilding or replacing published images. A conflicting version fails and needs a new release version.

Ordinary pushes, tag creation, draft releases and prereleases do not publish. The npm and Docker workflows report their outcomes separately; a failure in one does not undo the other registry's publication.

## Local verification

Build the four images with unique local tags:

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

These tests use local services and synthetic fixtures. The local demo builds its own images with `./dev up` and needs no registry credentials.
