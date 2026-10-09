#!/usr/bin/env bash
set -euo pipefail

component=${1:?Expected image component}
package="widefleet-$component"
image="ghcr.io/getmendra/$package:${VERSION:?}"
metadata="$RUNNER_TEMP/$package.json"
status=$(curl --silent --show-error --output "$metadata" --write-out '%{http_code}' \
  --header "Authorization: Bearer $GH_TOKEN" --header 'Accept: application/vnd.github+json' \
  "https://api.github.com/orgs/getmendra/packages/container/$package")
existing=0
case "$status" in
  200)
    jq -e --arg package "$package" '
      .name == $package and .package_type == "container" and .visibility == "private" and
      (.repository == null or .repository.full_name == "getmendra/widefleet")
    ' "$metadata"
    existing=$(gh api --paginate "orgs/getmendra/packages/container/$package/versions?per_page=100" \
      | jq -s --arg version "$VERSION" '[.[][] | select(.metadata.container.tags | index($version))] | length')
    ;;
  404) ;; # New GHCR packages default to private.
  *) cat "$metadata"; exit 1 ;;
esac
if [[ "$existing" != 0 ]]; then
  docker pull --platform linux/amd64 "$image"
  docker image inspect "$image" | jq -e --arg revision "$REVISION" --arg version "$VERSION" '
    .[0] | .Os == "linux" and .Architecture == "amd64" and
    .Config.Labels["org.opencontainers.image.source"] == "https://github.com/getmendra/widefleet" and
    .Config.Labels["org.opencontainers.image.revision"] == $revision and
    .Config.Labels["org.opencontainers.image.version"] == $version
  '
  # docker save/load preserves the image ID, but not registry digest references.
  docker image inspect "$image" | jq -er --arg prefix "ghcr.io/getmendra/$package@sha256:" \
    '.[0].RepoDigests[] | select(startswith($prefix))' > "$RELEASE_IMAGES/$component.digest"
elif [[ "$REQUIRE_EXISTING" == true ]]; then
  echo "Published release is missing $image; refusing to rebuild it." >&2
  exit 1
fi
printf '%s\n' "$existing" > "$RELEASE_IMAGES/$component.existing"
