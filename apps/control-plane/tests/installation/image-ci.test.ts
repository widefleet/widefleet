import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, matchesGlob } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";

const execute = promisify(execFile);

const script = fileURLToPath(new URL("../../../../tools/check-image-changes.py", import.meta.url));

const fixture = async () => {
  const directory = await mkdtemp(join(tmpdir(), "widefleet-image-changes-"));
  const output = join(directory, ".git/outputs");

  const git = (...args: string[]) =>
    execute("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], {
      cwd: directory,
    });

  const write = async (file: string, contents = "Fixture\n") => {
    await mkdir(dirname(join(directory, file)), { recursive: true });
    await writeFile(join(directory, file), contents);
  };

  const commit = async () => {
    await git("add", ".");
    await git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "--allow-empty",
      "-m",
      "Fixture",
    );

    return (await git("rev-parse", "HEAD")).stdout.trim();
  };

  await git("init", "--initial-branch=main", "--template=");
  const base = await commit();

  const run = async (environment = {}) => {
    await writeFile(output, "");
    await execute("python3", [script], {
      cwd: directory,
      env: {
        ...process.env,
        GITHUB_EVENT_NAME: "push",
        GITHUB_REF: "refs/heads/main",
        BASE_SHA: base,
        GITHUB_SHA: (await git("rev-parse", "HEAD")).stdout.trim(),
        GITHUB_OUTPUT: output,
        ...environment,
      },
    });

    return readFile(output, "utf8");
  };

  return { directory, base, git, write, commit, run };
};

it("selects both PR and main image checks before calling the unchanged shared suites", async () => {
  const workflow: unknown = parse(
    await readFile(
      new URL("../../../../.github/workflows/check-release-images.yaml", import.meta.url),
      "utf8",
    ),
  );

  expect(workflow).not.toHaveProperty("concurrency");
  expect(workflow).not.toHaveProperty("on.push.paths");
  expect(workflow).toMatchObject({
    on: { pull_request: null, push: { branches: ["main"] } },
    jobs: {
      changes: {
        outputs: { images: "${{ steps.changes.outputs.images }}" },
        steps: [
          expect.objectContaining({
            with: { ref: "${{ github.sha }}", "fetch-depth": 0, "persist-credentials": false },
          }),
          expect.objectContaining({
            id: "changes",
            env: { BASE_SHA: "${{ github.event.pull_request.base.sha || github.event.before }}" },
            run: "python3 tools/check-image-changes.py",
          }),
        ],
      },
      "pull-request": {
        needs: "changes",
        if: "github.event_name == 'pull_request' && needs.changes.outputs.images == 'true'",
        uses: "./.github/workflows/build-release-images.yaml",
        with: { ref: "${{ github.sha }}" },
        concurrency: {
          group: "check-release-images-${{ github.event.pull_request.number }}",
          "cancel-in-progress": true,
        },
        "cache-mode": "read",
      },
      main: {
        needs: "changes",
        if: "github.event_name == 'push' && needs.changes.outputs.images == 'true'",
        uses: "./.github/workflows/build-release-images.yaml",
        with: { ref: "${{ github.sha }}" },
        concurrency: {
          group: "check-release-images-${{ github.ref }}",
          "cancel-in-progress": true,
        },
        "cache-mode": "write",
      },
    },
  });
});

it.each([
  ["apps/control-plane/src/routes/+page.svelte", true],
  ["apps/control-plane/tests/runtime/container.test.ts", true],
  ["apps/control-plane/tests/environment.ts", true],
  ["apps/control-plane/tests/installation/auth-container.test.ts", true],
  ["packages/app-runtime/NOTICE", true],
  ["packages/contracts/src/index.ts", true],
  ["crates/platform-cli/src/main.rs", true],
  ["crates/platform-agent/src/main.rs", true],
  ["Cargo.lock", true],
  ["pnpm-lock.yaml", true],
  ["pnpm-workspace.yaml", true],
  ["tsconfig.base.json", true],
  [".npmrc", true],
  [".dockerignore", true],
  ["LICENSE", true],
  ["infra/runtime/Dockerfile", true],
  ["infra/runtime/Dockerfile.dockerignore", true],
  ["infra/agent/Dockerfile.dockerignore", true],
  ["infra/control-plane/Dockerfile.dockerignore", true],
  ["infra/test/compose.yaml", true],
  ["tools/check-image-changes.py", true],
  ["tools/test-release-images.sh", true],
  [".github/image-inputs.json", true],
  [".github/workflows/build-release-images.yaml", true],
  [".github/workflows/check-release-images.yaml", true],
  [".github/workflows/publish-cli.yaml", true],
  ["apps/docs/package.json", true],
  ["starters/sveltekit/package.json", true],
  ["templates/github/package.json", true],
  ["examples/apps/example/package.json", true],
  ["plugins/widefleet/skills/widefleet/SKILL.md", true],
  ["infra/runtime/licenses/celld/NOTICE", true],
  ["README.md", false],
  ["docs/cli-releases.md", false],
  ["apps/docs/blume.config.ts", false],
  ["apps/docs/docs/getting-started/installation.md", false],
  ["starters/sveltekit/src/routes/+page.svelte", false],
  ["starters/tanstack-start/tools/build.ts", false],
  ["templates/github/src/index.ts", false],
  ["tools/package-cli.ts", false],
  ["tools/cli-launcher.ts", false],
])("selects image checks for %s: %s", async (file, expected) => {
  const { directory, write, commit, run } = await fixture();

  try {
    await write(file);
    await commit();

    for (const event of ["push", "pull_request"])
      expect(await run({ GITHUB_EVENT_NAME: event })).toBe(`images=${expected}\n`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it.each(["control-plane", "runtime", "agent"])(
  "selects image checks for every file the %s build context includes",
  async (component) => {
    const root = new URL("../../../../", import.meta.url);

    const inputs = z
      .array(z.string())
      .parse(JSON.parse(await readFile(new URL(".github/image-inputs.json", root), "utf8")));

    const scoped = await readFile(
      new URL(`infra/${component}/Dockerfile.dockerignore`, root),
      "utf8",
    );

    // A context inclusion without a matching input would let a change to that
    // file skip the image checks that build it.
    const uncovered = scoped
      .split("\n")
      .filter((line) => line.startsWith("!"))
      .map((line) => line.slice(1))
      .filter((pattern) => {
        const sample = pattern.replaceAll("**", "sample/file").replaceAll("*", "sample");

        return !inputs.some((input) => matchesGlob(sample, input));
      });

    expect(uncovered).toEqual([]);
  },
);

it("examines the entire push and PR, including more than 300 files and earlier commits", async () => {
  const { directory, write, commit, run } = await fixture();

  try {
    for (let index = 0; index < 310; index++) await write(`docs/${index}.md`);
    await write("packages/app-runtime/src/loader.ts");
    await commit();
    await write("README.md");
    await commit();

    for (const event of ["push", "pull_request"])
      expect(await run({ GITHUB_EVENT_NAME: event })).toBe("images=true\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("includes deleted files and moves out of image inputs", async () => {
  const { directory, git, write, commit, run } = await fixture();

  try {
    await write("packages/contracts/src/obsolete.ts");
    const base = await commit();
    await git("mv", "packages/contracts/src/obsolete.ts", "README.md");
    const moved = await commit();

    for (const event of ["push", "pull_request"])
      expect(await run({ BASE_SHA: base, GITHUB_EVENT_NAME: event })).toBe("images=true\n");
    await git("reset", "--hard", base);
    await git("rm", "packages/contracts/src/obsolete.ts");
    await commit();
    expect(await run({ BASE_SHA: base })).toBe("images=true\n");
    // A force push is compared directly with its previous tip, not their merge base.
    expect(await run({ BASE_SHA: moved })).toBe("images=false\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("uses the PR merge base, excluding changes made only on the target branch", async () => {
  const { directory, base, git, write, commit, run } = await fixture();

  try {
    await write("packages/contracts/src/target-branch.ts");
    const target = await commit();
    await git("checkout", "-b", "feature", base);
    await write("README.md");
    await commit();
    expect(await run({ BASE_SHA: target, GITHUB_EVENT_NAME: "pull_request" })).toBe(
      "images=false\n",
    );
    expect(await run({ BASE_SHA: target })).toBe("images=true\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("runs all image checks when the previous commit is unavailable and skips an empty diff", async () => {
  const { directory, run } = await fixture();

  try {
    expect(await run()).toBe("images=false\n");
    expect(await run({ BASE_SHA: "0".repeat(40) })).toBe("images=true\n");
    expect(await run({ BASE_SHA: "1".repeat(40) })).toBe("images=true\n");
    await expect(run({ GITHUB_SHA: "2".repeat(40) })).rejects.toThrow("does not match");
    await expect(run({ BASE_SHA: "invalid" })).rejects.toThrow("complete commit IDs");
    await expect(run({ GITHUB_REF: "refs/tags/v0.7.2" })).rejects.toThrow("main-branch push");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
