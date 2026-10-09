#!/usr/bin/env bash
set -euo pipefail

test "${GITHUB_REPOSITORY:?}" = widefleet/widefleet
metadata=$(mktemp)
trap 'rm -f "$metadata"' EXIT

# GraphQL distinguishes a missing release from a failed lookup and includes drafts.
gh api graphql \
  -f owner="${GITHUB_REPOSITORY%/*}" -f repo="${GITHUB_REPOSITORY#*/}" -f tag="${RELEASE_TAG:?}" \
  -f query='query($owner: String!, $repo: String!, $tag: String!) {
    repository(owner: $owner, name: $repo) {
      release(tagName: $tag) { tagName isDraft isPrerelease }
    }
  }' > "$metadata"
jq -e '.data.repository != null' "$metadata"

if jq -e '.data.repository.release == null' "$metadata" > /dev/null; then
  gh release create "$RELEASE_TAG" --repo "$GITHUB_REPOSITORY" \
    --draft --verify-tag --target "${REVISION:?}" --title "Widefleet $RELEASE_TAG" --generate-notes
fi

# Preserve existing draft notes, and never start a new publication for a public release.
gh release view "$RELEASE_TAG" --repo "$GITHUB_REPOSITORY" --json tagName,isDraft,isPrerelease \
  | jq -e --arg tag "$RELEASE_TAG" '.tagName == $tag and .isDraft == true and .isPrerelease == false'
