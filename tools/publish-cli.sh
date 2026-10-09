#!/usr/bin/env bash
set -euo pipefail

directory=${CLI_RELEASE_DIRECTORY:?}
package="$directory/widefleet-${VERSION:?}.tgz"
(
  cd "$directory"
  sha256sum --check "widefleet-$VERSION.tgz.sha256"
)
tar -xOf "$package" package/package.json | jq -e --arg version "$VERSION" '
  .name == "widefleet" and .version == $version and
  .repository.url == "git+https://github.com/widefleet/widefleet.git" and
  .publishConfig.registry == "https://registry.npmjs.org" and .publishConfig.access == "public" and
  .os == ["linux"] and .cpu == ["x64"] and .libc == ["glibc"]
'
metadata="$directory/registry.json"
status=$(curl --silent --show-error --retry 3 --connect-timeout 15 --max-time 60 \
  --output "$metadata" --write-out '%{http_code}' "https://registry.npmjs.org/widefleet/$VERSION")
case "$status" in
  200) ;; # Compare existing bytes below; npm versions are never replaced.
  404) npm publish "$package" --registry=https://registry.npmjs.org --access=public --provenance --ignore-scripts ;;
  *) echo "npm version lookup failed: HTTP $status" >&2; exit 1 ;;
esac
expected="sha512-$(openssl dgst -sha512 -binary "$package" | openssl base64 -A)"
actual=$(npm view "widefleet@$VERSION" dist.integrity --json --registry=https://registry.npmjs.org | jq -er .)
test "$actual" = "$expected"
npm view "widefleet@$VERSION" repository.url --json --registry=https://registry.npmjs.org \
  | jq -e '. == "git+https://github.com/widefleet/widefleet.git"'

export PNPM_HOME="$directory/registry-install"
export PATH="$PNPM_HOME/bin:$PATH"
mkdir -p "$PNPM_HOME/bin"
pnpm --config.global-dir="$directory/global-packages" add --global --ignore-scripts \
  --registry=https://registry.npmjs.org "widefleet@$VERSION"
test "$(widefleet --version)" = "widefleet $VERSION"
widefleet init "$directory/registry-app"
test -f "$directory/registry-app/.gitignore"
test -f "$directory/registry-app/pnpm-lock.yaml"
echo "Published and verified widefleet@$VERSION on npm." >> "${GITHUB_STEP_SUMMARY:?}"
