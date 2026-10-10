# Container release publishing

Configure Docker Hub and verify images before using the [platform release procedure](cli-releases.md#publish-a-version). The same release publishes four Linux amd64 images:

| Docker Hub repository     | Purpose                                         |
| ------------------------- | ----------------------------------------------- |
| `widefleet/runtime`       | celld runtime                                   |
| `widefleet/agent`         | Deployment agent and CLI                        |
| `widefleet/control-plane` | Management server, API and initialization tools |
| `widefleet/sso`           | OAuth2 Proxy and configuration supervisor       |

Operators use the [installation guide](https://widefleet.com/docs/self-hosting/installation#pull-the-release-images) to pull and pin the images.

## Configure Docker Hub publishing

Create all four repositories under the `widefleet` namespace with **Public** visibility. The publishing workflow checks every destination before its first push and refuses private repositories.

Add these GitHub Actions secrets to `widefleet/widefleet`:

- `DOCKERHUB_USERNAME`: the Docker Hub login identity that can publish to all four repositories.
- `DOCKERHUB_TOKEN`: that identity's Docker Hub access token with read/write access to the repositories.

Keep tokens in GitHub Actions secrets. Docker Hub credentials are provided only to the publishing job after tests pass. See [Docker access tokens](https://docs.docker.com/security/access-tokens/).

## Publish a version

Follow the [release setup and tag-push instructions](cli-releases.md#publish-a-version). Both CLI and packaged image tests must pass before either registry publication starts. A successful release includes `widefleet-images-VERSION.env` and its checksum alongside the CLI archives; the manifest contains the anonymously verified image digests.

Release jobs use the same [image build workflow](../.github/workflows/build-release-images.yaml) as relevant pull requests and `main` pushes. Publication must use the artifacts tested in that release run and verify anonymous digest pulls so an authenticated maintainer's successful pull cannot hide a private or inaccessible release image.

Images use exact version tags and source commit labels. There is no floating `latest` tag and no update to running installations. Published version tags are never replaced by the workflow. Enable Docker Hub tag immutability for the version tags as an additional registry control if available for your account.

## Retry a partial publication

Use **Re-run failed jobs** on the original GitHub Actions run. Existing images must match the release's source commit, version, platform and source URL. If a build job is rerun, it pulls and retests existing images with any missing images. This lets a rerun finish a partial push without rebuilding or replacing published images. A conflicting version fails and needs a new release version.

For cross-registry failures and draft release recovery, use the [shared recovery procedure](cli-releases.md#retry-a-partial-publication). Ordinary pushes to `main` and GitHub Release events do not publish images.

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
