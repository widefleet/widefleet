import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execute = promisify(execFile);

const script = fileURLToPath(new URL("../../../../tools/check-main-changes.py", import.meta.url));

const fixture = async () => {
  const directory = await mkdtemp(join(tmpdir(), "widefleet-main-changes-"));
  const repository = join(directory, "source");
  const output = join(directory, "output");
  await mkdir(repository);

  const git = (...args: string[]) =>
    execute("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], {
      cwd: repository,
    });

  await git("init", "--initial-branch=main", "--template=");
  await git("config", "user.name", "Fixture");
  await git("config", "user.email", "fixture@example.test");
  let sequence = 0;

  const commit = async (files: string[]) => {
    for (const file of files) {
      await mkdir(dirname(join(repository, file)), { recursive: true });
      await writeFile(join(repository, file), `Fixture ${sequence++}\n`);
    }

    await git("add", "--all");
    await git("commit", "--allow-empty", "-m", "Fixture");

    return (await git("rev-parse", "HEAD")).stdout.trim();
  };

  const before = await commit(["README.md"]);

  const run = async (environment = {}) => {
    await rm(output, { force: true });
    await execute("python3", [script], {
      cwd: repository,
      env: {
        ...process.env,
        GITHUB_EVENT_NAME: "push",
        GITHUB_REF: "refs/heads/main",
        BEFORE_SHA: before,
        GITHUB_SHA: (await git("rev-parse", "HEAD")).stdout.trim(),
        GITHUB_OUTPUT: output,
        ...environment,
      },
    });

    return readFile(output, "utf8");
  };

  return { directory, output, git, commit, run };
};

it.each([
  ["control-plane API", ["apps/control-plane/src/routes/api/apps/+server.ts"]],
  ["control-plane UI", ["apps/control-plane/src/routes/(auth)/(workspace)/apps/+page.svelte"]],
  ["control-plane manifest", ["apps/control-plane/package.json"]],
  ["runtime", ["packages/app-runtime/src/index.ts", "crates/platform-agent/src/main.rs"]],
  ["API contracts", ["packages/contracts/src/index.ts"]],
  ["images", ["infra/runtime/Dockerfile", "tools/build-release-binaries.sh"]],
  ["CLI tests", ["apps/control-plane/tests/cli.test.ts"]],
  ["canary tests", ["apps/control-plane/tests/installation/canary-triggers.test.ts"]],
  ["contributor docs", ["docs/cli-releases.md", "README.md", "AGENTS.md"]],
  ["user docs", ["apps/docs/docs/guides/app-services.md", "apps/docs/docs/reference/cli.mdx"]],
  ["docs site", ["apps/docs/blume.config.ts", "apps/docs/package.json"]],
  ["website", ["apps/website/src/routes/index.tsx"]],
] satisfies [string, string[]][])("does not publish for %s changes", async (_name, files) => {
  const { directory, commit, run } = await fixture();

  try {
    await commit(files);
    expect(await run()).toContain("canary=false\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it.each([
  "crates/platform-cli/src/main.rs",
  "crates/platform-cli/Cargo.toml",
  "crates/platform-cli/licenses/example.txt",
  "crates/platform-core/src/http.rs",
  "crates/platform-core/Cargo.toml",
  "crates/platform-agent/Cargo.toml",
  "Cargo.toml",
  "Cargo.lock",
  "rust-toolchain.toml",
  ".cargo/config.toml",
  "package.json",
  "tsconfig.json",
  "tsconfig.base.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  ".npmrc",
  ".pnpmfile.cjs",
  "patches/dependency.patch",
  "tools/cargo.sh",
  "tools/package-cli.ts",
  "tools/cli-launcher.ts",
  "tools/cli-platforms.ts",
  "tools/cli-tools.ts",
  "tools/prepare-cli-canary.py",
  "tools/publish-cli.sh",
  "tools/wait-for-npm-package.sh",
  "starters/sveltekit/src/routes/+page.svelte",
  "starters/sveltekit/README.md",
  "starters/sveltekit/AGENTS.md",
  "starters/sveltekit/pnpm-lock.yaml",
  "starters/tanstack-start/src/routes/index.tsx",
  "starters/tanstack-start/README.md",
  "starters/tanstack-start/pnpm-lock.yaml",
  "tools/oxlint/anti-slop/index.ts",
  "tools/oxlint/anti-slop/.config",
  ".gitattributes",
  ".gitignore",
  ".oxlintrc.json",
  ".oxfmtrc.json",
  "LICENSE",
  "apps/docs/docs/getting-started/installation.md",
  ".github/workflows/publish-cli.yaml",
  ".github/workflows/cli-platforms.yaml",
  ".github/workflows/check-suites.yaml",
  ".github/workflows/actions.lock",
  ".github/cli-inputs.json",
  "tools/check-main-changes.py",
])("publishes for CLI input %s", async (file) => {
  const { directory, commit, run } = await fixture();

  try {
    await commit([file]);
    expect(await run()).toContain("canary=true\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it.each([
  ["apps/control-plane/src/routes/api/apps/+server.ts", "checks=true\ncanary=false\n"],
  ["apps/docs/blume.config.ts", "checks=true\ncanary=false\n"],
  ["docs/cli-releases.md", "checks=false\ncanary=false\n"],
  ["apps/docs/docs/reference/cli.mdx", "checks=false\ncanary=false\n"],
  ["apps/docs/docs/getting-started/installation.md", "checks=false\ncanary=true\n"],
  ["starters/sveltekit/README.md", "checks=false\ncanary=true\n"],
  ["tools/oxlint/anti-slop/UPSTREAM.md", "checks=false\ncanary=true\n"],
  ["crates/platform-cli/src/main.rs", "checks=true\ncanary=true\n"],
])("selects independent checks and publication for %s", async (file, expected) => {
  const { directory, commit, run } = await fixture();

  try {
    await commit([file]);
    expect(await run()).toBe(expected);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("considers the whole push rather than only its last commit", async () => {
  const { directory, commit, run } = await fixture();

  try {
    await commit(["crates/platform-core/src/http.rs"]);
    await commit(["docs/cli-releases.md"]);
    expect(await run()).toBe("checks=true\ncanary=true\n");
    // The decision is unchanged when retrying the same workflow run.
    expect(await run({ GITHUB_RUN_ATTEMPT: "2" })).toBe("checks=true\ncanary=true\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("detects deletions and renames out of the CLI package", async () => {
  const { directory, git, commit, run } = await fixture();

  try {
    const before = await commit(["crates/platform-cli/src/old.rs"]);
    await git("mv", "crates/platform-cli/src/old.rs", "moved.rs");
    await commit([]);
    expect(await run({ BEFORE_SHA: before })).toBe("checks=true\ncanary=true\n");

    const installed = await commit(["starters/sveltekit/README.md"]);
    await git("rm", "starters/sveltekit/README.md");
    await commit([]);
    expect(await run({ BEFORE_SHA: installed })).toBe("checks=false\ncanary=true\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("does not truncate large pushes or split unusual filenames", async () => {
  const { directory, commit, run } = await fixture();

  try {
    await commit([
      ...Array.from({ length: 350 }, (_, index) => `docs/file-${index}.md`),
      "starters/sveltekit/src/with spaces\nand newline.ts",
    ]);
    expect(await run()).toBe("checks=true\ncanary=true\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("runs all checks when the previous revision is absent and skips an empty diff", async () => {
  const { directory, run } = await fixture();

  try {
    expect(await run()).toBe("checks=false\ncanary=false\n");
    expect(await run({ BEFORE_SHA: "0".repeat(40) })).toBe("checks=true\ncanary=true\n");
    expect(await run({ BEFORE_SHA: "a".repeat(40) })).toBe("checks=true\ncanary=true\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("rejects wrong events, commits and malformed revisions without writing outputs", async () => {
  const { directory, output, run } = await fixture();

  try {
    for (const environment of [
      { GITHUB_EVENT_NAME: "pull_request" },
      { GITHUB_REF: "refs/tags/v0.7.2" },
      { GITHUB_REF: "refs/heads/feature" },
      { GITHUB_SHA: "b".repeat(40) },
      { BEFORE_SHA: "--stat" },
    ]) {
      await expect(run(environment)).rejects.toThrow();
      await expect(readFile(output, "utf8")).rejects.toThrow();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
