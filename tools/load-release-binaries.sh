#!/usr/bin/env bash
set -euo pipefail

binaries=${RELEASE_BINARIES:?}
revision=$(git rev-parse HEAD)
tar -xf "$binaries/release-binaries.tar" -C "$binaries"
test "$(cat "$binaries/revision")" = "$revision"
(cd "$binaries" && sha256sum --check SHA256SUMS)
test -x "$binaries/source/target/release/platform-agent"
test -x "$binaries/source/target/release/widefleet"
