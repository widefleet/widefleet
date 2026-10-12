#!/usr/bin/env bash
set -euo pipefail

directory=${CLI_RELEASE_DIRECTORY:?}
version=${VERSION:?}
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
native_packages=(widefleet-linux-x64-gnu widefleet-darwin-arm64 widefleet-darwin-x64 widefleet-win32-x64-msvc)
packages=("${native_packages[@]}" widefleet)

# Check every tested artifact and immutable version before publishing anything.
for package in "${packages[@]}"; do
  archive="$directory/$package-$version.tgz"
  (cd "$directory" && sha256sum --check "$package-$version.tgz.sha256")
  tar -xOf "$archive" package/package.json > "$directory/$package.manifest.json"
  jq -e --arg name "$package" --arg version "$version" '
    .name == $name and .version == $version and .scripts == null and
    .repository.url == "git+https://github.com/widefleet/widefleet.git" and
    .publishConfig.registry == "https://registry.npmjs.org" and .publishConfig.access == "public"
  ' "$directory/$package.manifest.json"

  if [[ "$package" != widefleet ]]; then
    case "$package" in
      widefleet-linux-x64-gnu) os=linux; cpu=x64; executable=widefleet; libc='["glibc"]' ;;
      widefleet-darwin-arm64) os=darwin; cpu=arm64; executable=widefleet; libc=null ;;
      widefleet-darwin-x64) os=darwin; cpu=x64; executable=widefleet; libc=null ;;
      widefleet-win32-x64-msvc) os=win32; cpu=x64; executable=widefleet.exe; libc=null ;;
    esac
    jq -e --arg os "$os" --arg cpu "$cpu" --arg executable "./$executable" --argjson libc "$libc" '
      .os == [$os] and .cpu == [$cpu] and .libc == $libc and
      .exports["./widefleet"] == $executable
    ' "$directory/$package.manifest.json"
  fi

  expected="sha512-$(openssl dgst -sha512 -binary "$archive" | openssl base64 -A)"
  printf '%s\n' "$expected" > "$directory/$package.integrity"
  metadata="$directory/$package.registry.json"
  status=$(curl --silent --show-error --retry 3 --connect-timeout 15 --max-time 60 \
    --output "$metadata" --write-out '%{http_code}' "https://registry.npmjs.org/$package/$version")
  case "$status" in
    200)
      jq -e --arg name "$package" --arg version "$version" --arg integrity "$expected" '
        .name == $name and .version == $version and .dist.integrity == $integrity and
        .repository.url == "git+https://github.com/widefleet/widefleet.git"
      ' "$metadata"
      printf 'existing\n' > "$directory/$package.state"
      ;;
    404) printf 'missing\n' > "$directory/$package.state" ;;
    *) echo "npm version lookup failed for $package: HTTP $status" >&2; exit 1 ;;
  esac
done

jq -e --arg version "$version" '
  .bin.widefleet == "./bin/widefleet.mjs" and
  .optionalDependencies == {
    "widefleet-linux-x64-gnu": $version,
    "widefleet-darwin-arm64": $version,
    "widefleet-darwin-x64": $version,
    "widefleet-win32-x64-msvc": $version
  }
' "$directory/widefleet.manifest.json"

publish_package() {
  local package=$1
  if [[ "$(cat "$directory/$package.state")" == missing ]]; then
    npm publish "$directory/$package-$version.tgz" \
      --registry=https://registry.npmjs.org --access=public --provenance --ignore-scripts
  fi
  bash "$(dirname "${BASH_SOURCE[0]}")/wait-for-npm-package.sh" \
    "$package" "$version" "$(cat "$directory/$package.integrity")"
}

# Upload and check independent native packages concurrently. Join every worker,
# including failures, before the launcher can reference these exact-version bytes.
pids=()
for package in "${native_packages[@]}"; do
  publish_package "$package" &
  pids+=("$!")
done
failed=false
for index in "${!pids[@]}"; do
  if ! wait "${pids[$index]}"; then
    echo "Native package publication failed: ${native_packages[$index]}@$version" >&2
    failed=true
  fi
done
[[ "$failed" == false ]] || exit 1
publish_package widefleet

export PNPM_HOME="$directory/registry-install"
export PATH="$PNPM_HOME/bin:$PATH"
mkdir -p "$PNPM_HOME/bin"
pnpm --config.global-dir="$directory/global-packages" add --global --ignore-scripts \
  --registry=https://registry.npmjs.org "widefleet@$version"
test "$(widefleet --version)" = "widefleet $version"
widefleet init "$directory/registry-app"
test -f "$directory/registry-app/.gitignore"
test -f "$directory/registry-app/pnpm-lock.yaml"
echo "Verified widefleet@$version and its native packages on npm." >> "${GITHUB_STEP_SUMMARY:?}"
