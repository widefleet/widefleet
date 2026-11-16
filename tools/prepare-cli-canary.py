#!/usr/bin/env python3
"""Stamp only the disposable build checkout; retries keep the same version."""

import json
import os
from pathlib import Path
import re
import subprocess
import tomllib


def prepare():
    run = os.environ["GITHUB_RUN_NUMBER"]
    revision = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
    if not re.fullmatch(r"[1-9][0-9]*", run):
        raise ValueError("Expected a positive GitHub run number")
    if revision != os.environ["GITHUB_SHA"]:
        raise ValueError("Canary checkout does not match the workflow commit")

    package_path = Path("package.json")
    cargo_path = Path("Cargo.toml")
    lock_path = Path("Cargo.lock")
    package = json.loads(package_path.read_text())
    cargo_source = cargo_path.read_text()
    cargo = tomllib.loads(cargo_source)
    lock_source = lock_path.read_text()
    lock = tomllib.loads(lock_source)
    base = package["version"]
    if not re.fullmatch(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", base):
        raise ValueError("Expected a stable source version")
    if cargo["workspace"]["package"]["version"] != base:
        raise ValueError("Product and Cargo workspace versions differ")

    version = f"{base}-canary.{run}.g{revision[:12]}"
    members = []
    for member in cargo["workspace"]["members"]:
        manifest = tomllib.loads(Path(member, "Cargo.toml").read_text())["package"]
        if manifest["version"] != {"workspace": True}:
            raise ValueError("Workspace members must inherit the product version")
        members.append(manifest["name"])

    # Preserve dependency resolution: only the local workspace package versions change.
    for name in members:
        entries = [
            entry for entry in lock["package"]
            if entry["name"] == name and "source" not in entry
        ]
        if len(entries) != 1 or entries[0]["version"] != base:
            raise ValueError(f"Unexpected lockfile version for {name}")
        pattern = rf'(\[\[package\]\]\nname = "{re.escape(name)}"\nversion = "){re.escape(base)}(")'
        lock_source, count = re.subn(
            pattern, lambda match: f"{match[1]}{version}{match[2]}", lock_source
        )
        if count != 1:
            raise ValueError(f"Cannot stamp lockfile entry for {name}")

    pattern = rf'(\[workspace\.package\]\n[^\[]*?\bversion = "){re.escape(base)}(")'
    cargo_source, count = re.subn(
        pattern, lambda match: f"{match[1]}{version}{match[2]}", cargo_source
    )
    if count != 1:
        raise ValueError("Cannot stamp Cargo workspace version")

    package["version"] = version
    package_path.write_text(json.dumps(package, indent=2) + "\n")
    cargo_path.write_text(cargo_source)
    lock_path.write_text(lock_source)
    with open(os.environ["GITHUB_ENV"], "a") as environment:
        environment.write(f"VERSION={version}\n")
    print(version)


if __name__ == "__main__":
    prepare()
