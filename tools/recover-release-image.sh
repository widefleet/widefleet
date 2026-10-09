#!/usr/bin/env bash
set -euo pipefail

component=${1:?Expected image component}
case "$component" in runtime|agent|control-plane|sso) ;; *) exit 1 ;; esac
package="widefleet-$component"
image="docker.io/widefleet/$package:${VERSION:?}"
metadata="${RELEASE_IMAGES:?}/$component.registry.json"
endpoint="https://hub.docker.com/v2/namespaces/widefleet/repositories/$package"
existing=0
status=$(curl --silent --show-error --retry 3 --connect-timeout 15 --max-time 60 \
  --output "$metadata" --write-out '%{http_code}' "$endpoint")
case "$status" in
  200)
    jq -e --arg package "$package" '
      .name == $package and .namespace == "widefleet" and .is_private == false
    ' "$metadata"
    status=$(curl --silent --show-error --retry 3 --connect-timeout 15 --max-time 60 \
      --output "$metadata" --write-out '%{http_code}' "$endpoint/tags/$VERSION")
    case "$status" in
      200) jq -e --arg version "$VERSION" '.name == $version' "$metadata"; existing=1 ;;
      404) ;;
      *) echo "Docker Hub tag lookup failed: HTTP $status" >&2; exit 1 ;;
    esac
    ;;
  404) ;;
  *) echo "Docker Hub repository lookup failed: HTTP $status" >&2; exit 1 ;;
esac
if [[ "$existing" == 1 ]]; then
  docker pull --platform linux/amd64 "$image"
  docker image inspect "$image" | jq -e --arg revision "${REVISION:?}" --arg version "$VERSION" '
    .[0] | .Os == "linux" and .Architecture == "amd64" and
    .Config.Labels["org.opencontainers.image.source"] == "https://github.com/widefleet/widefleet" and
    .Config.Labels["org.opencontainers.image.revision"] == $revision and
    .Config.Labels["org.opencontainers.image.version"] == $version
  '
  # Docker Hub may omit docker.io when reporting canonical digest references.
  docker image inspect "$image" | jq -er --arg prefix "widefleet/$package@sha256:" '
    .[0].RepoDigests[] | ltrimstr("docker.io/") | select(startswith($prefix)) | "docker.io/" + .
  ' > "$RELEASE_IMAGES/$component.digest"
elif [[ "${REQUIRE_EXISTING:-false}" == true ]]; then
  echo "Published image is missing: $image; refusing to rebuild it." >&2
  exit 1
fi
printf '%s\n' "$existing" > "$RELEASE_IMAGES/$component.existing"
