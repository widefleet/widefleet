import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execute = promisify(execFile);

const script = fileURLToPath(new URL("../../../../tools/check-release.sh", import.meta.url));

const fixture = async () => {
  const directory = await mkdtemp(join(tmpdir(), "widefleet-release-source-"));

  const git = (...args: string[]) =>
    execute("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], {
      cwd: directory,
    });

  await git("init", "--initial-branch=main", "--template=");
  await git("config", "user.name", "Release fixture");
  await git("config", "user.email", "release@example.test");
  await writeFile(join(directory, "package.json"), JSON.stringify({ version: "0.3.0" }));
  await writeFile(join(directory, "Cargo.toml"), '[workspace.package]\nversion = "0.3.0"\n');
  await git("add", "package.json", "Cargo.toml");
  await git("commit", "-m", "Fixture");
  await git("update-ref", "refs/remotes/origin/main", "HEAD");
  await git("tag", "v0.3.0");

  const run = (environment = {}) =>
    execute("bash", [script], {
      cwd: directory,
      env: {
        PATH: `${directory}:${process.env["PATH"] ?? "/usr/bin:/bin"}`,
        GITHUB_REPOSITORY: "widefleet/widefleet",
        RELEASE_TAG: "v0.3.0",
        GITHUB_ENV: join(directory, "environment"),
        GITHUB_OUTPUT: join(directory, "outputs"),
        ...environment,
      },
    });

  return { directory, git, run };
};

it("accepts a version tag from main without requiring a published release", async () => {
  const { directory, git, run } = await fixture();

  try {
    await run();
    const revision = (await git("rev-parse", "HEAD")).stdout.trim();
    expect(await readFile(join(directory, "environment"), "utf8")).toContain(
      `VERSION=0.3.0\nREVISION=${revision}\nSOURCE_DATE_EPOCH=`,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("resolves annotated version tags to the tested commit", async () => {
  const { directory, git, run } = await fixture();

  try {
    await git("tag", "--force", "--annotate", "v0.3.0", "--message", "Release fixture");
    await run();
    const revision = (await git("rev-parse", "HEAD")).stdout.trim();
    expect(await readFile(join(directory, "outputs"), "utf8")).toBe(`revision=${revision}\n`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("rejects a checkout that differs from the version tag even when both are on main", async () => {
  const { directory, git, run } = await fixture();

  try {
    await git("commit", "--allow-empty", "-m", "Newer main commit");
    await git("update-ref", "refs/remotes/origin/main", "HEAD");
    await expect(run()).rejects.toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("rejects source outside main even when its tag and versions match", async () => {
  const { directory, git, run } = await fixture();

  try {
    await git("switch", "-c", "unmerged");
    await git("commit", "--allow-empty", "-m", "Unmerged fixture");
    await git("tag", "--force", "v0.3.0");
    await expect(run()).rejects.toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("rejects mismatched versions, a different repository and malformed tags", async () => {
  const { directory, run } = await fixture();

  try {
    await expect(run({ GITHUB_REPOSITORY: "example/fork" })).rejects.toThrow();
    await expect(run({ RELEASE_TAG: "v0.3.0-beta.1" })).rejects.toThrow();
    await writeFile(join(directory, "Cargo.toml"), '[workspace.package]\nversion = "0.4.0"\n');
    await expect(run()).rejects.toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
