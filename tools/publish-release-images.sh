#!/usr/bin/env bash
set -euo pipefail

# Check all destinations and existing bytes before the first push.
for component in runtime agent control-plane sso; do
  package="$component"
  curl --fail --silent --show-error --retry 3 --connect-timeout 15 --max-time 60 \
    "https://hub.docker.com/v2/namespaces/widefleet/repositories/$package" \
    | jq -e --arg package "$package" '
        .name == $package and .namespace == "widefleet" and .is_private == false
      '
  bash tools/recover-release-image.sh "$component"
  test "$(docker image inspect "docker.io/widefleet/$package:$VERSION" --format '{{.Id}}')" \
    = "$(cat "$RELEASE_IMAGES/$component.id")"
done

manifest="$RELEASE_IMAGES/widefleet-images-$VERSION.env"
printf '# Widefleet %s; source commit %s\n' "$VERSION" "$REVISION" > "$manifest"
for component in runtime agent control-plane sso; do
  image="docker.io/widefleet/$component:$VERSION"
  if [[ "$(cat "$RELEASE_IMAGES/$component.existing")" == 0 ]]; then
    docker push "$image"
  fi
  # Verify anonymous access, the source labels and the exact tested image ID.
  anonymous=$(mktemp -d)
  DOCKER_CONFIG="$anonymous" docker pull --platform linux/amd64 "$image"
  digest=$(docker image inspect "$image" | jq -er --arg prefix "widefleet/$component@sha256:" '
    .[0].RepoDigests[] | ltrimstr("docker.io/") | select(startswith($prefix)) | "docker.io/" + .
  ')
  DOCKER_CONFIG="$anonymous" docker pull --platform linux/amd64 "$digest"
  rmdir "$anonymous"
  test "$(docker image inspect "$digest" --format '{{.Id}}')" = "$(cat "$RELEASE_IMAGES/$component.id")"
  variable="PLATFORM_${component^^}_IMAGE"
  printf '%s=%s\n' "${variable//-/_}" "$digest" >> "$manifest"
done
(
  cd "$RELEASE_IMAGES"
  sha256sum "widefleet-images-$VERSION.env" > "widefleet-images-$VERSION.env.sha256"
)
cat "$manifest" >> "${GITHUB_STEP_SUMMARY:?}"
