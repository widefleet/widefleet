#!/usr/bin/env bash
set -euo pipefail

test "${GITHUB_REPOSITORY:?}" = widefleet/widefleet
test "${RELEASE_TAG:?}" = "v${VERSION:?}"
cli=${CLI_RELEASE_DIRECTORY:?}
images=${RELEASE_IMAGES:?}

(
  cd "$cli"
  sha256sum --check "widefleet-$VERSION.tgz.sha256"
  sha256sum --check "widefleet-cli-$VERSION-linux-x64.tar.gz.sha256"
)
(
  cd "$images"
  sha256sum --check "widefleet-images-$VERSION.env.sha256"
)

# Upload and compare all six files before the draft can become immutable.
bash "$(dirname "${BASH_SOURCE[0]}")/upload-release-assets.sh" \
  "$cli/widefleet-$VERSION.tgz" \
  "$cli/widefleet-$VERSION.tgz.sha256" \
  "$cli/widefleet-cli-$VERSION-linux-x64.tar.gz" \
  "$cli/widefleet-cli-$VERSION-linux-x64.tar.gz.sha256" \
  "$images/widefleet-images-$VERSION.env" \
  "$images/widefleet-images-$VERSION.env.sha256"

draft=$(gh release view "$RELEASE_TAG" --repo "$GITHUB_REPOSITORY" --json isDraft --jq .isDraft)
if [[ "$draft" == true ]]; then
  gh release edit "$RELEASE_TAG" --repo "$GITHUB_REPOSITORY" --draft=false --verify-tag
else
  # A rerun after publication only verifies identical assets, including on immutable releases.
  test "$draft" = false
fi
gh release view "$RELEASE_TAG" --repo "$GITHUB_REPOSITORY" --json tagName,isDraft,isPrerelease \
  | jq -e --arg tag "$RELEASE_TAG" '.tagName == $tag and .isDraft == false and .isPrerelease == false'
echo "Published the complete GitHub Release $RELEASE_TAG." >> "${GITHUB_STEP_SUMMARY:?}"
