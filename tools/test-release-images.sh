#!/usr/bin/env bash
set -euo pipefail

export PLATFORM_CONTROL_PLANE_IMAGE="docker.io/widefleet/widefleet-control-plane:${VERSION:?}"
export PLATFORM_AGENT_IMAGE="docker.io/widefleet/widefleet-agent:$VERSION"
export PLATFORM_SSO_IMAGE="docker.io/widefleet/widefleet-sso:$VERSION"
export PLATFORM_RUNTIME_IMAGE="docker.io/widefleet/widefleet-runtime:$VERSION"
docker compose -f infra/test/compose.yaml up -d --wait
RUN_INSTALLATION_TESTS=1 RUN_PACKAGED_EDGE_TESTS=1 pnpm exec vitest run --no-file-parallelism apps/control-plane/tests/installation apps/control-plane/tests/edge/configuration.test.ts
test "$(docker run --rm --network=none "$PLATFORM_AGENT_IMAGE" --version)" = "platform-agent $VERSION"
test "$(docker run --rm --network=none --entrypoint widefleet "$PLATFORM_AGENT_IMAGE" --version)" = "widefleet $VERSION"
RUN_IMAGE_TESTS=1 pnpm exec vitest run apps/control-plane/tests/runtime/container.test.ts
docker compose --env-file infra/deployment.env.example -f infra/compose.yaml \
  --profile agent --profile images config --quiet
