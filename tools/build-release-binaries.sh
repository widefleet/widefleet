#!/usr/bin/env bash
set -euo pipefail

# Keep compiled dependencies outside BuildKit layers: changing workspace source or
# the release version should not rebuild every dependency. The same pinned Debian
# toolchain is used by the ordinary agent Dockerfile and this cached CI build.
cache=${RELEASE_CARGO_CACHE:?Set RELEASE_CARGO_CACHE to an absolute directory}
binaries=${RELEASE_BINARIES:?Set RELEASE_BINARIES to an absolute directory}
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
    cargo build --locked --release --package platform-agent --package platform-cli
  '
install -m 755 "$cache/target/release/platform-agent" "$cache/target/release/widefleet" \
  "$binaries/source/target/release/"
