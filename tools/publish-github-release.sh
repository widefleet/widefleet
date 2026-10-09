#!/usr/bin/env bash
set -euo pipefail

test "${GITHUB_REPOSITORY:?}" = widefleet/widefleet
test "${RELEASE_TAG:?}" = "v${VERSION:?}"
cli=${CLI_RELEASE_DIRECTORY:?}
images=${RELEASE_IMAGES:?}

assets=("$cli/widefleet-$VERSION.tgz")
for platform in linux-x64-gnu darwin-arm64 darwin-x64 win32-x64-msvc; do
  assets+=("$cli/widefleet-$platform-$VERSION.tgz")
done
for archive in linux-x64 darwin-arm64 darwin-x64 win32-x64; do
  assets+=("$cli/widefleet-cli-$VERSION-$archive.tar.gz")
done
for asset in "${assets[@]}"; do
  (cd "$cli" && sha256sum --check "$(basename "$asset").sha256")
done
(
  cd "$images"
  sha256sum --check "widefleet-images-$VERSION.env.sha256"
)

assets+=("$images/widefleet-images-$VERSION.env")
attachments=()
for asset in "${assets[@]}"; do
  attachments+=("$asset" "$asset.sha256")
done

# Compare every platform's downloads before the draft can become immutable.
bash "$(dirname "${BASH_SOURCE[0]}")/upload-release-assets.sh" "${attachments[@]}"

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
