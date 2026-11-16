import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execute = promisify(execFile);

const script = fileURLToPath(new URL("../../../../tools/prepare-cli-canary.py", import.meta.url));

const fixture = async () => {
  const directory = await mkdtemp(join(tmpdir(), "widefleet-canary-"));

  const git = (...args: string[]) =>
    execute("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], {
      cwd: directory,
    });

  await git("init", "--initial-branch=main", "--template=");
  await mkdir(join(directory, "crates/cli"), { recursive: true });
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({ version: "0.7.0", private: true }),
  );
  await writeFile(
    join(directory, "Cargo.toml"),
    '[workspace]\nmembers = ["crates/cli"]\n\n[workspace.package]\nlicense = "MIT"\nversion = "0.7.0"\n',
  );
  await writeFile(
    join(directory, "crates/cli/Cargo.toml"),
    '[package]\nname = "platform-cli"\nversion.workspace = true\n',
  );
  await writeFile(
    join(directory, "Cargo.lock"),
    'version = 4\n\n[[package]]\nname = "platform-cli"\nversion = "0.7.0"\n\n[[package]]\nname = "external"\nversion = "0.7.0"\nsource = "registry+https://example.test"\nchecksum = "unchanged"\n',
  );
  await git("add", ".");
  await git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "-m",
    "Fixture",
  );
  const revision = (await git("rev-parse", "HEAD")).stdout.trim();

  const run = (environment = {}) =>
    execute("python3", [script], {
      cwd: directory,
      env: {
        ...process.env,
        GITHUB_RUN_NUMBER: "42",
        GITHUB_SHA: revision,
        GITHUB_ENV: join(directory, "environment"),
        ...environment,
      },
    });

  return { directory, git, revision, run };
};

it("stamps identical Cargo, npm and lockfile versions and reproduces them on retry", async () => {
  const { directory, git, revision, run } = await fixture();

  try {
    const originalLock = await readFile(join(directory, "Cargo.lock"), "utf8");
    const version = `0.7.0-canary.42.g${revision.slice(0, 12)}`;
    await run();
    expect(await readFile(join(directory, "package.json"), "utf8")).toContain(
      `"version": "${version}"`,
    );
    expect(await readFile(join(directory, "Cargo.toml"), "utf8")).toContain(
      `version = "${version}"`,
    );
    expect(await readFile(join(directory, "Cargo.lock"), "utf8")).toBe(
      originalLock.replace(
        'name = "platform-cli"\nversion = "0.7.0"',
        `name = "platform-cli"\nversion = "${version}"`,
      ),
    );
    expect(await readFile(join(directory, "environment"), "utf8")).toBe(`VERSION=${version}\n`);
    await git("restore", ".");
    expect((await run({ GITHUB_RUN_ATTEMPT: "2" })).stdout.trim()).toBe(version);
    await git("restore", ".");
    expect((await run({ GITHUB_RUN_NUMBER: "43" })).stdout.trim()).not.toBe(version);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("rejects a different commit or malformed run number without modifying the source", async () => {
  const { directory, git, run } = await fixture();

  try {
    await expect(run({ GITHUB_SHA: "0".repeat(40) })).rejects.toThrow("does not match");

    for (const number of ["0", "01", "42\nVERSION=bad", "invalid"])
      await expect(run({ GITHUB_RUN_NUMBER: number })).rejects.toThrow(
        "positive GitHub run number",
      );
    expect((await git("diff")).stdout).toBe("");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("rejects mismatched product and lockfile versions before changing files", async () => {
  const { directory, git, run } = await fixture();

  try {
    await writeFile(join(directory, "package.json"), '{"version":"0.8.0"}');
    const before = (await git("diff")).stdout;
    await expect(run()).rejects.toThrow("versions differ");
    expect((await git("diff")).stdout).toBe(before);
    await git("restore", ".");
    await writeFile(
      join(directory, "Cargo.lock"),
      '[[package]]\nname = "platform-cli"\nversion = "0.6.0"\n',
    );
    await expect(run()).rejects.toThrow("Unexpected lockfile version");
    expect(await readFile(join(directory, "package.json"), "utf8")).toBe(
      '{"version":"0.7.0","private":true}',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
