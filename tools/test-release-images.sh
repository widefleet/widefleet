#!/usr/bin/env bash
set -euo pipefail

export PLATFORM_CONTROL_PLANE_IMAGE="docker.io/widefleet/control-plane:${VERSION:?}"
export PLATFORM_AGENT_IMAGE="docker.io/widefleet/agent:$VERSION"
export PLATFORM_RUNTIME_IMAGE="docker.io/widefleet/runtime:$VERSION"
runtime=${RELEASE_RUNTIME:?}
mkdir -p "$runtime"
docker run --rm --network=none --entrypoint cat "$PLATFORM_RUNTIME_IMAGE" \
  /opt/widefleet-runtime/release.json > "$runtime/release.json"
jq -e --arg version "$VERSION" '.version == $version' "$runtime/release.json"
cmp packages/app-runtime/dist/release.json "$runtime/release.json"
docker run --rm --network=none --entrypoint node "$PLATFORM_CONTROL_PLANE_IMAGE" \
  --input-type=module --eval 'import { readFileSync } from "node:fs"; process.stdout.write(readFileSync(new URL(import.meta.resolve("@platform/app-runtime/release"))));' \
  | cmp - "$runtime/release.json"
(cd "$runtime" && sha256sum release.json > release.json.sha256)

docker compose -f infra/test/compose.yaml up -d --wait
RUN_INSTALLATION_TESTS=1 RUN_PACKAGED_EDGE_TESTS=1 pnpm exec vitest run --no-file-parallelism apps/control-plane/tests/installation apps/control-plane/tests/edge/configuration.test.ts
test "$(docker run --rm --network=none "$PLATFORM_AGENT_IMAGE" --version)" = "platform-agent $VERSION"
test "$(docker run --rm --network=none --entrypoint widefleet "$PLATFORM_AGENT_IMAGE" --version)" = "widefleet $VERSION"
RUN_IMAGE_TESTS=1 pnpm exec vitest run apps/control-plane/tests/runtime/container.test.ts
docker compose --env-file infra/deployment.env.example -f infra/compose.yaml \
  --profile agent config --quiet
