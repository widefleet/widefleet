#!/usr/bin/env python3
"""Select image checks from the complete PR or push diff, without API file limits."""

import json
import os
from pathlib import Path
import re
import subprocess


def select():
    event = os.environ["GITHUB_EVENT_NAME"]
    if event != "pull_request" and not (
        event == "push" and os.environ["GITHUB_REF"] == "refs/heads/main"
    ):
        raise ValueError("Expected a pull request or main-branch push")

    base = os.environ["BASE_SHA"]
    revision = os.environ["GITHUB_SHA"]
    if not all(re.fullmatch(r"[0-9a-f]{40}", value) for value in (base, revision)):
        raise ValueError("Expected complete commit IDs")
    head = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
    if head != revision:
        raise ValueError("Checkout does not match the event commit")

    available = subprocess.run(
        ["git", "cat-file", "-e", f"{base}^{{commit}}"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    ).returncode == 0
    # New branches and unavailable pre-force-push commits must not suppress checks.
    changed = True
    if base != "0" * 40 and available:
        patterns = json.loads(
            (Path(__file__).resolve().parent.parent / ".github/image-inputs.json").read_text()
        )
        if not isinstance(patterns, list) or not patterns or not all(
            isinstance(pattern, str) and pattern for pattern in patterns
        ):
            raise ValueError("Image inputs must be a nonempty list of Git glob paths")

        comparison = [f"{base}...{revision}"] if event == "pull_request" else [base, revision]
        # Git's glob pathspecs match all changed paths, including deleted sources.
        result = subprocess.run(
            ["git", "diff", "--no-renames", "--quiet", *comparison, "--",
             *(f":(glob){pattern}" for pattern in patterns)],
            check=False,
        )
        if result.returncode not in (0, 1):
            result.check_returncode()
        changed = result.returncode == 1

    with open(os.environ["GITHUB_OUTPUT"], "a") as output:
        output.write(f"images={str(changed).lower()}\n")


if __name__ == "__main__":
    select()
