#!/usr/bin/env bash
set -euo pipefail

name=${1:?Package name is required}
version=${2:?Package version is required}
integrity=${3:?Expected archive integrity is required}
timeout=${NPM_PROPAGATION_TIMEOUT_SECONDS:-7200}
[[ "$timeout" =~ ^[1-9][0-9]*$ ]] || { echo 'NPM_PROPAGATION_TIMEOUT_SECONDS must be a positive integer.' >&2; exit 1; }
deadline=$((SECONDS + timeout))
metadata=$(mktemp)
trap 'rm -f "$metadata"' EXIT

timed_out() {
  echo "Timed out after ${timeout}s waiting for npm availability: $name@$version. Re-run failed jobs once npm finishes processing." >&2
  exit 1
}

request() {
  local remaining=$((deadline - SECONDS))
  ((remaining > 0)) || timed_out
  local limit=60
  if ((remaining < limit)); then limit=$remaining; fi
  # The outer loop owns retries and the deadline, including network failures.
  status=$(curl --silent --show-error --connect-timeout 15 --max-time "$limit" \
    --output "$metadata" --write-out '%{http_code}' "$@") || status=000
  ((SECONDS < deadline)) || timed_out
  case "$status" in
    200) return 0 ;;
    000|404|408|429|5??) return 1 ;;
    *) echo "npm availability check failed for $name@$version: HTTP $status" >&2; exit 1 ;;
  esac
}

echo "Waiting for $name@$version to become installable on npm (timeout ${timeout}s)."
while true; do
  ready=true
  # npm view and npm install use independently cached metadata representations.
  for accept in application/json application/vnd.npm.install-v1+json; do
    if ! request --header "Accept: $accept" "https://registry.npmjs.org/$name"; then
      ready=false
      break
    fi
    jq -e 'type == "object"' "$metadata" > /dev/null
    if ! jq -e --arg version "$version" '.versions[$version] != null' "$metadata" > /dev/null; then
      ready=false
      break
    fi
    # A visible version with different bytes is a conflict, not propagation delay.
    jq -e --arg name "$name" --arg version "$version" --arg integrity "$integrity" '
      .versions[$version] | .name == $name and .version == $version and .dist.integrity == $integrity
    ' "$metadata" > /dev/null || { echo "npm integrity mismatch for $name@$version." >&2; exit 1; }
    if [[ "$accept" == application/json ]]; then
      jq -e --arg version "$version" '
        .versions[$version].repository.url == "git+https://github.com/widefleet/widefleet.git"
      ' "$metadata" > /dev/null || { echo "npm repository mismatch for $name@$version." >&2; exit 1; }
    fi
  done
  if [[ "$ready" == true ]]; then
    tarball=$(jq -er --arg version "$version" '.versions[$version].dist.tarball' "$metadata")
    if request --head --location "$tarball"; then
      echo "$name@$version is available on npm."
      break
    fi
  fi
  echo "npm is not ready for $name@$version yet; waiting before checking again."
  remaining=$((deadline - SECONDS))
  ((remaining > 0)) || timed_out
  delay=15
  if ((remaining < delay)); then delay=$remaining; fi
  sleep "$delay"
done
