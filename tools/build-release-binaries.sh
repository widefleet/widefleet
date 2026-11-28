#!/usr/bin/env bash
set -euo pipefail

# Keep compiled dependencies outside BuildKit layers: changing workspace source or
# the release version should not rebuild every dependency. The same pinned Debian
# toolchain is used by the ordinary agent Dockerfile and this cached CI build.
cache=${RELEASE_CARGO_CACHE:?Set RELEASE_CARGO_CACHE to an absolute directory}
binaries=${RELEASE_BINARIES:?Set RELEASE_BINARIES to an absolute directory}
# Release images need the agent and the CLI; an image that only runs the CLI
# sets RELEASE_PACKAGES=platform-cli and skips compiling the agent.
read -r -a packages <<< "${RELEASE_PACKAGES:-platform-agent platform-cli}"
cargo_packages=()
executables=()
for package in "${packages[@]}"; do
  case "$package" in
    platform-agent) executables+=(platform-agent) ;;
    platform-cli) executables+=(widefleet) ;;
    *) echo "RELEASE_PACKAGES names $package; use platform-agent and platform-cli" >&2; exit 1 ;;
  esac
  cargo_packages+=(--package "$package")
done
mkdir -p "$cache/cargo" "$cache/target" "$binaries/source/target/release"
docker build --platform linux/amd64 --target toolchain \
  --file infra/agent/Dockerfile --tag widefleet-release-toolchain .
user="$(id -u):$(id -g)"
if docker info --format '{{json .SecurityOptions}}' | grep -q 'name=rootless'; then
  user=0:0 # Container root maps to the caller on a rootless local daemon.
fi
docker run --rm --platform linux/amd64 --user "$user" \
  --mount "type=bind,source=$PWD,target=/source,readonly" \
  --mount "type=bind,source=$cache/cargo,target=/cargo" \
  --mount "type=bind,source=$cache/target,target=/target" \
  --env CARGO_HOME=/cargo --env CARGO_TARGET_DIR=/target --env CARGO_INCREMENTAL=0 \
  widefleet-release-toolchain bash -euo pipefail -c '
    # Use the toolchain baked into the pinned image; lint components are not
    # needed here. Avoid rustup trying to install them as the unprivileged user.
    RUSTUP_TOOLCHAIN=$(rustup default | cut -d " " -f 1)
    export RUSTUP_TOOLCHAIN
    cd /source
    cargo build --locked --release "$@"
  ' bash "${cargo_packages[@]}"
for executable in "${executables[@]}"; do
  install -m 755 "$cache/target/release/$executable" "$binaries/source/target/release/"
done

# Tar retains executable permissions when transported through Actions artifacts.
git rev-parse HEAD > "$binaries/revision"
(
  cd "$binaries"
  sha256sum "${executables[@]/#/source/target/release/}" > SHA256SUMS
  tar -cf release-binaries.tar revision SHA256SUMS source
)
