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
  const release = { tag_name: "v0.3.0", draft: false, prerelease: false };
  await writeFile(join(directory, "release.json"), JSON.stringify(release));
  await writeFile(join(directory, "gh"), '#!/bin/sh\ncat "$FIXTURE/release.json"\n', {
    mode: 0o755,
  });

  const run = (environment = {}) =>
    execute("bash", [script], {
      cwd: directory,
      env: {
        PATH: `${directory}:${process.env["PATH"] ?? "/usr/bin:/bin"}`,
        FIXTURE: directory,
        GITHUB_REPOSITORY: "widefleet/widefleet",
        RELEASE_TAG: "v0.3.0",
        GITHUB_ENV: join(directory, "environment"),
        GITHUB_OUTPUT: join(directory, "outputs"),
        ...environment,
      },
    });

  return { directory, git, release, run };
};

it("accepts a published matching release from main and records its exact revision", async () => {
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

it.each([{ draft: true }, { prerelease: true }, { tag_name: "v0.2.0" }])(
  "rejects an unpublished or mismatched release: %j",
  async (override) => {
    const { directory, release, run } = await fixture();

    try {
      await writeFile(join(directory, "release.json"), JSON.stringify({ ...release, ...override }));
      await expect(run()).rejects.toThrow();
      await expect(readFile(join(directory, "environment"))).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

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
