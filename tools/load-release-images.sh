#!/usr/bin/env bash
set -euo pipefail

components=(runtime agent control-plane)
if [[ -f infra/sso/Dockerfile ]]; then components+=(sso); fi

for component in "${components[@]}"; do
  image="docker.io/widefleet/$component:${VERSION:?}"
  docker load --input "$RELEASE_IMAGES/$component.tar"
  test "$(docker image inspect "$image" --format '{{.Id}}')" = "$(cat "$RELEASE_IMAGES/$component.id")"
  docker image inspect "$image" | jq -e --arg revision "$REVISION" --arg version "$VERSION" '
    .[0] | .Os == "linux" and .Architecture == "amd64" and
    .Config.Labels["org.opencontainers.image.source"] == "https://github.com/widefleet/widefleet" and
    .Config.Labels["org.opencontainers.image.revision"] == $revision and
    .Config.Labels["org.opencontainers.image.version"] == $version
  '
done
