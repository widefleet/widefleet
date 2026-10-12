import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execute = promisify(execFile);

const root = fileURLToPath(new URL("../../../../", import.meta.url));

const fixture = async () => {
  const directory = await mkdtemp(join(tmpdir(), "widefleet-local-images-"));

  const state = join(directory, ".local/demo");

  await mkdir(join(directory, "infra/local"), { recursive: true });
  await mkdir(state, { recursive: true });
  await copyFile(join(root, "dev"), join(directory, "dev"));
  await copyFile(join(root, "infra/local/images.env"), join(directory, "infra/local/images.env"));
  await writeFile(
    join(directory, "docker"),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\t' "$@" >> "$LOCAL_TEST_LOG"
printf 'runtime=%s\\n' "$PLATFORM_RUNTIME_IMAGE" >> "$LOCAL_TEST_LOG"
case "$1 $2" in
  'container inspect') exit 1 ;;
  'image inspect') exit "$LOCAL_TEST_RUNTIME_MISSING" ;;
  'info --format') echo linux/x86_64 ;;
  pull*) exit "$LOCAL_TEST_PULL_FAILURE" ;;
esac
`,
    { mode: 0o755 },
  );

  const log = () => readFile(join(directory, "docker.log"), "utf8");

  const run = (args: string[] = [], environment = {}) =>
    execute("bash", [join(directory, "dev"), ...args], {
      cwd: directory,
      env: {
        PATH: `${directory}:${process.env["PATH"] ?? "/usr/bin:/bin"}`,
        DOCKER_HOST: "unix:///test/docker.sock",
        LOCAL_TEST_LOG: join(directory, "docker.log"),
        LOCAL_TEST_RUNTIME_MISSING: "0",
        LOCAL_TEST_PULL_FAILURE: "0",
        ...environment,
      },
    });

  return { directory, state, log, run };
};

it("starts a fresh demo with pinned images and builds only its tooling", async () => {
  const { directory, state, log, run } = await fixture();

  try {
    await run([], { LOCAL_TEST_RUNTIME_MISSING: "1" });
    const commands = await log();
    expect(commands).toContain("pull\tdocker.io/widefleet/runtime@sha256:");
    expect(commands).toContain("build\ttools\t");
    expect(commands).not.toContain("build\t-f\tinfra/");
    expect(commands).toContain("runtime=docker.io/widefleet/runtime@sha256:");
    expect(commands).toContain("local/control.ts\tdeploy-if-needed\t");
    expect(await readFile(join(state, "image-mode"), "utf8")).toBe("release\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("reuses the cached runtime without another pull", async () => {
  const { directory, log, run } = await fixture();

  try {
    await run(["up"]);
    expect(await log()).not.toContain("pull\t");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("fails a missing release pull instead of falling back to compiling the platform", async () => {
  const { directory, log, run } = await fixture();

  try {
    await expect(
      run(["up"], { LOCAL_TEST_RUNTIME_MISSING: "1", LOCAL_TEST_PULL_FAILURE: "1" }),
    ).rejects.toThrow();
    expect(await log()).not.toContain("build\t");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("builds matching platform images when explicitly requested and remembers that mode", async () => {
  const { directory, state, log, run } = await fixture();

  try {
    await run(["up", "--build"]);
    const commands = await log();
    expect(commands).toContain(
      "build\t-f\tinfra/runtime/Dockerfile\t-t\twidefleet-local-runtime:source\t",
    );
    expect(commands).toContain(
      "build\t--build-arg\tRUNTIME_IMAGE=widefleet-local-runtime:source\t-f\tinfra/agent/Dockerfile\t",
    );
    expect(commands).toContain(
      "build\t-f\tinfra/control-plane/Dockerfile\t-t\twidefleet-local-control-plane:source\t",
    );
    expect(commands).toContain("local/control.ts\tdeploy\t");
    expect(await readFile(join(state, "image-mode"), "utf8")).toBe("source\n");
    await writeFile(join(directory, "docker.log"), "");
    await run(["cli", "apps"]);
    expect(await log()).toContain("runtime=widefleet-local-runtime:source");
    expect(await log()).not.toContain("build\t");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("preserves source mode for demos initialized before release images were supported", async () => {
  const { directory, state, log, run } = await fixture();

  try {
    await mkdir(join(state, "platform"));
    await run(["up"]);
    expect(await log()).not.toContain("docker.io/widefleet/");
    expect(await readFile(join(state, "image-mode"), "utf8")).toBe("source\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("requires a reset before switching an initialized release demo to source images", async () => {
  const { directory, state, log, run } = await fixture();

  try {
    await writeFile(join(state, "image-mode"), "release\n");
    await expect(run(["up", "--build"])).rejects.toThrow("reset --yes");
    await expect(log()).rejects.toThrow();
    expect(await readFile(join(state, "image-mode"), "utf8")).toBe("release\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it.each([["up", "--unknown"], ["deploy", "--build"], ["reset"]])(
  "rejects invalid arguments before contacting Docker: %j",
  async (...args) => {
    const { directory, log, run } = await fixture();

    try {
      await expect(run(args)).rejects.toThrow();
      await expect(log()).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
