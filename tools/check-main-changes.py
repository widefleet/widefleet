#!/usr/bin/env python3
"""Select main checks and canary publication before building their shared artifacts."""

import json
import os
from pathlib import Path
import re
import subprocess


def select():
    if os.environ["GITHUB_EVENT_NAME"] != "push" or os.environ["GITHUB_REF"] != "refs/heads/main":
        raise ValueError("Expected a main-branch push")

    before = os.environ["BEFORE_SHA"]
    revision = os.environ["GITHUB_SHA"]
    if not all(re.fullmatch(r"[0-9a-f]{40}", value) for value in (before, revision)):
        raise ValueError("Expected complete commit IDs")
    head = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
    if head != revision:
        raise ValueError("Checkout does not match the push commit")

    # A new branch or an unavailable pre-force-push commit must not suppress checks.
    available = subprocess.run(
        ["git", "cat-file", "-e", f"{before}^{{commit}}"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    ).returncode == 0
    if before == "0" * 40 or not available:
        checks = canary = True
    else:
        # No rename detection: a move out of a packaged directory is also a change.
        files = subprocess.check_output(
            ["git", "diff", "--no-renames", "--name-only", "-z", before, revision, "--"]
        ).decode("utf8", errors="surrogateescape").split("\0")
        files = [path for path in files if path]
        patterns = json.loads(
            (Path(__file__).resolve().parent.parent / ".github/cli-inputs.json").read_text()
        )
        if not isinstance(patterns, list) or not patterns or not all(
            isinstance(pattern, str) and re.fullmatch(r"[^*?![\]{}]+(?:/\*\*)?", pattern)
            for pattern in patterns
        ):
            raise ValueError("CLI inputs must be literal paths or recursive directory prefixes")

        canary = any(
            path.startswith(pattern[:-2]) if pattern.endswith("/**") else path == pattern
            for path in files for pattern in patterns
        )
        # Preserve Check's service-suite coverage, including documentation-site code.
        checks = any(
            not (path.endswith(".md") or path.startswith(("docs/", "apps/docs/docs/")))
            for path in files
        )

    with open(os.environ["GITHUB_OUTPUT"], "a") as output:
        output.write(f"checks={str(checks).lower()}\ncanary={str(canary).lower()}\n")


if __name__ == "__main__":
    select()
