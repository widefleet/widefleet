#!/usr/bin/env bash
set -euo pipefail

test "${GITHUB_REPOSITORY:?}" = widefleet/widefleet
tag=${RELEASE_TAG:?Set RELEASE_TAG to the version tag}
[[ "$tag" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]
version=${tag#v}
revision=$(git rev-parse HEAD)
test "$(git rev-parse "$tag^{commit}")" = "$revision"
git merge-base --is-ancestor "$revision" refs/remotes/origin/main

python3 - "$version" <<'PY'
import json
import sys
import tomllib
from pathlib import Path

version = sys.argv[1]
assert json.loads(Path("package.json").read_text())["version"] == version
assert tomllib.loads(Path("Cargo.toml").read_text())["workspace"]["package"]["version"] == version
PY

{
  echo "VERSION=$version"
  echo "REVISION=$revision"
  echo "SOURCE_DATE_EPOCH=$(git show -s --format=%ct HEAD)"
} >> "${GITHUB_ENV:?}"

printf 'revision=%s\n' "$revision" >> "${GITHUB_OUTPUT:?}"
