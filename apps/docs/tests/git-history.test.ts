import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "vitest";

test("docs builds recover page history from a shallow checkout without changing HEAD", async () => {
  const directory = await mkdtemp(join(tmpdir(), "docs-history-"));
  const origin = join(directory, "origin");
  const checkout = join(directory, "checkout");
  const prepare = fileURLToPath(new URL("../scripts/prepare-git-history.ts", import.meta.url));

  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: checkout, encoding: "utf8" }).trim();

  try {
    execFileSync("git", ["init", "--quiet", "--initial-branch=main", origin]);
    execFileSync("git", ["-C", origin, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", origin, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", origin, "config", "commit.gpgsign", "false"]);
    await writeFile(join(origin, "page.md"), "# Page\n");
    execFileSync("git", ["-C", origin, "add", "."]);
    execFileSync("git", ["-C", origin, "commit", "--quiet", "-m", "Add page"], {
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: "2026-01-01T12:00:00Z",
        GIT_COMMITTER_DATE: "2026-01-01T12:00:00Z",
      },
    });
    execFileSync(
      "git",
      ["-C", origin, "commit", "--quiet", "--allow-empty", "-m", "Unrelated build"],
      {
        env: {
          ...process.env,
          GIT_AUTHOR_DATE: "2026-02-01T12:00:00Z",
          GIT_COMMITTER_DATE: "2026-02-01T12:00:00Z",
        },
      },
    );
    execFileSync("git", ["clone", "--quiet", "--depth=1", pathToFileURL(origin).href, checkout]);
    const head = git("rev-parse", "HEAD");

    assert.equal(git("rev-parse", "--is-shallow-repository"), "true");
    execFileSync(process.execPath, [prepare], { cwd: checkout });
    assert.equal(git("rev-parse", "--is-shallow-repository"), "false");
    assert.equal(git("rev-parse", "HEAD"), head);
    assert.equal(
      Date.parse(git("log", "-1", "--format=%cI", "--", "page.md")),
      Date.parse("2026-01-01T12:00:00Z"),
    );

    // A complete checkout must also build offline, without fetching origin again.
    git("remote", "remove", "origin");
    execFileSync(process.execPath, [prepare], { cwd: checkout });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
