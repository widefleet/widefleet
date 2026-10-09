#!/usr/bin/env bash
set -euo pipefail

test "$#" -gt 0
directory=$(mktemp -d)
trap 'rm -rf -- "$directory"' EXIT
gh api "repos/${GITHUB_REPOSITORY:?}/releases/tags/${RELEASE_TAG:?}" > "$directory/release.json"
jq -e --arg tag "$RELEASE_TAG" '
  .tag_name == $tag and .draft == false and .prerelease == false
' "$directory/release.json"

# Check existing attachments before adding anything; never replace published bytes.
for asset in "$@"; do
  test -f "$asset"
  name=$(basename "$asset")
  count=$(jq --arg name "$name" '[.assets[] | select(.name == $name)] | length' "$directory/release.json")
  test "$count" -le 1
  if [[ "$count" == 1 ]]; then
    gh release download "$RELEASE_TAG" --repo "$GITHUB_REPOSITORY" --pattern "$name" --dir "$directory"
    cmp "$asset" "$directory/$name"
  fi
done
for asset in "$@"; do
  name=$(basename "$asset")
  if [[ ! -f "$directory/$name" ]]; then
    gh release upload "$RELEASE_TAG" "$asset" --repo "$GITHUB_REPOSITORY"
    gh release download "$RELEASE_TAG" --repo "$GITHUB_REPOSITORY" --pattern "$name" --dir "$directory"
    cmp "$asset" "$directory/$name"
  fi
done
