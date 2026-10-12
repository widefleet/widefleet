#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
test "${GITHUB_REPOSITORY:?}" = widefleet/widefleet
tag=${RELEASE_TAG:?Expected release tag}

# The workflow serializes overview jobs; check release order after acquiring its slot.
latest=$(gh api --paginate "repos/$GITHUB_REPOSITORY/releases?per_page=100" | jq -ser '
  [.[][] | select(.draft == false and .prerelease == false) | .tag_name |
    select(test("^v(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$"))] |
  max_by(ltrimstr("v") | split(".") | map(tonumber)) //
  error("No published stable platform release found")
')
if [[ "$tag" != "$latest" ]]; then
  printf 'Skipping Docker Hub overviews for %s; latest published version is %s.\n' "$tag" "$latest"
  exit 0
fi

: "${DOCKERHUB_USERNAME:?Expected Docker Hub username}"
: "${DOCKERHUB_TOKEN:?Expected Docker Hub access token}"

umask 077
temporary=$(mktemp -d)
trap 'rm -rf "$temporary"' EXIT

# Prepare every overview before making any changes to Docker Hub.
for component in runtime agent control-plane sso; do
  overview="$root/.github/dockerhub/$component.md"
  test -s "$overview"
  jq -n --rawfile overview "$overview" '{full_description: $overview}' > "$temporary/$component.json"
done

# Keep credentials out of command arguments and API responses out of logs.
jq -n '{identifier: env.DOCKERHUB_USERNAME, secret: env.DOCKERHUB_TOKEN}' \
  | curl --fail --silent --show-error --retry 3 --connect-timeout 15 --max-time 60 \
      --json @- https://hub.docker.com/v2/auth/token > "$temporary/auth.json"
jq -er '.access_token | strings | select(length > 0) | "Authorization: Bearer \(.)"' \
  "$temporary/auth.json" > "$temporary/authorization"

for component in runtime agent control-plane sso; do
  curl --fail --silent --show-error --retry 3 --connect-timeout 15 --max-time 60 \
    --request PATCH --header "@$temporary/authorization" \
    --json "@$temporary/$component.json" --output /dev/null \
    "https://hub.docker.com/v2/namespaces/widefleet/repositories/$component"
  printf 'Updated Docker Hub overview: widefleet/%s\n' "$component"
done
