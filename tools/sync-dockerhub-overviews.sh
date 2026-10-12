#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
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
    "https://hub.docker.com/v2/repositories/widefleet/$component"
  printf 'Updated Docker Hub overview: widefleet/%s\n' "$component"
done
