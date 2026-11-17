#!/usr/bin/env bash
set -euo pipefail
project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ "$(uname -s)/$(uname -m)" != "Linux/x86_64" ]]; then
  echo 'The pinned MVP runtime currently targets Linux x86_64.' >&2
  exit 1
fi
mkdir -p "$project_root/.tools"
temporary="$(mktemp -d "$project_root/.tools/celld-install.XXXXXX")"
trap 'rm -rf -- "$temporary"' EXIT
curl --fail --location --proto '=https' 'https://github.com/widefleet/celld/releases/download/v0.6.3-widefleet.1/celld-x86_64-unknown-linux-gnu.gz' --output "$temporary/celld.gz"
gzip -dc "$temporary/celld.gz" > "$temporary/celld"
(cd "$temporary" && printf '%s\n' '3078dfead83d2f13bd79ca23c43968a8753fe4e222698b6a50dc6e416eb85073  celld' | sha256sum --check)
chmod 755 "$temporary/celld"
mv "$temporary/celld" "$project_root/.tools/celld"
"$project_root/.tools/celld" --version
