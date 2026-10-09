#!/usr/bin/env bash
set -euo pipefail

for component in runtime agent control-plane sso; do
  image="docker.io/widefleet/widefleet-$component:${VERSION:?}"
  docker load --input "$RELEASE_IMAGES/$component.tar"
  test "$(docker image inspect "$image" --format '{{.Id}}')" = "$(cat "$RELEASE_IMAGES/$component.id")"
  docker image inspect "$image" | jq -e --arg revision "$REVISION" --arg version "$VERSION" '
    .[0] | .Os == "linux" and .Architecture == "amd64" and
    .Config.Labels["org.opencontainers.image.source"] == "https://github.com/widefleet/widefleet" and
    .Config.Labels["org.opencontainers.image.revision"] == $revision and
    .Config.Labels["org.opencontainers.image.version"] == $version
  '
done
