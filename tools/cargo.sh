#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -x "$project_root/.tools/cargo/bin/cargo" ]]; then
  export CARGO_HOME="$project_root/.tools/cargo"
  export RUSTUP_HOME="$project_root/.tools/rustup"
  export PATH="$CARGO_HOME/bin:$PATH"
fi

exec cargo "$@"
