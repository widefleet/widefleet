import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execute = promisify(execFile);

const root = fileURLToPath(new URL("../../../../", import.meta.url));

const fleet = "00000000-0000-4000-8000-000000000001";

const fixture = async () => {
  const directory = await mkdtemp(join(tmpdir(), "widefleet-local-images-"));

  const state = join(directory, ".local/demo");

  await mkdir(state, { recursive: true });
  await copyFile(join(root, "dev"), join(directory, "dev"));
  await writeFile(
    join(directory, "docker"),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\t' "$@" >> "$LOCAL_TEST_LOG"
printf 'runtime=%s version=%s\\n' "\${PLATFORM_RUNTIME_IMAGE:-}" "\${PLATFORM_RELEASE_VERSION:-}" >> "$LOCAL_TEST_LOG"
images="docker.io/widefleet/runtime@sha256:aaa docker.io/widefleet/agent@sha256:bbb docker.io/widefleet/control-plane@sha256:ccc $LOCAL_TEST_VERSION"
if [[ "\${!#}" == local/check-version.ts ]]; then exit "$LOCAL_TEST_VERSION_FAILURE"; fi
case "$1 $2" in
  'run --rm')
    if [[ "\${!#}" == /local-release.ts ]]; then
      [[ "$LOCAL_TEST_LATEST_FAILURE" == 0 ]] || exit 1
      echo "$images"
    fi ;;
  'container inspect')
    [[ "$3" == platform-fleet-${fleet} && "$LOCAL_TEST_FLEET_EXISTS" == 1 ]] ;;
  'inspect platform-fleet-'*)
    if [[ "\${!#}" == *app-platform.fleet-id* ]]; then echo '${fleet}'; else echo sha256:old; fi ;;
  'image inspect')
    if [[ "$3" == widefleet-local-tools:0.1.0 ]]; then echo "$images"
    elif [[ "\${!#}" == '{{.Id}}' ]]; then echo "$LOCAL_TEST_RUNTIME_ID"
    else exit "$LOCAL_TEST_RUNTIME_MISSING"; fi ;;
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
        LOCAL_TEST_VERSION: "1.2.3",
        LOCAL_TEST_LATEST_FAILURE: "0",
        LOCAL_TEST_RUNTIME_MISSING: "0",
        LOCAL_TEST_RUNTIME_ID: "sha256:old",
        LOCAL_TEST_PULL_FAILURE: "0",
        LOCAL_TEST_FLEET_EXISTS: "0",
        LOCAL_TEST_VERSION_FAILURE: "0",
        ...environment,
      },
    });

  return { directory, state, log, run };
};

it("checks the latest release on every start, including existing demos", async () => {
  const { directory, state, log, run } = await fixture();

  try {
    await mkdir(join(state, "platform"));
    await run([], { LOCAL_TEST_RUNTIME_MISSING: "1" });
    expect(await log()).toContain("pull\tdocker.io/widefleet/runtime@sha256:");
    expect(await log()).toContain("build\ttools\t");
    expect(await log()).not.toContain("build\t-f\tinfra/");
    expect(await log()).toContain("local/control.ts\tdeploy-if-needed\t");
    await writeFile(join(directory, "docker.log"), "");
    await run(["up"], { LOCAL_TEST_VERSION: "1.2.4" });
    expect(await log()).toContain("/local-release.ts\t");
    expect(await log()).toContain("version=1.2.4");
    expect(await log()).not.toContain("pull\t");
    await expect(readFile(join(state, "image-mode"))).rejects.toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("allows source builds after a failed release download without a reset", async () => {
  const { directory, log, run } = await fixture();

  try {
    await expect(
      run(["up"], { LOCAL_TEST_RUNTIME_MISSING: "1", LOCAL_TEST_PULL_FAILURE: "1" }),
    ).rejects.toThrow();
    expect(await log()).not.toContain("build\t");
    await run(["up", "--build"]);
    expect(await log()).toContain(
      "build\t-f\tinfra/runtime/Dockerfile\t-t\twidefleet-local-runtime:source\t",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("uses source builds only for the explicitly requested start and retains data", async () => {
  const { directory, state, log, run } = await fixture();

  try {
    await run(["up"]);
    await writeFile(join(state, "retained-data"), "notes and photos");
    await writeFile(join(directory, "docker.log"), "");
    await run(["up", "--build"]);
    expect(await log()).toContain(
      "build\t--build-arg\tRUNTIME_IMAGE=widefleet-local-runtime:source\t-f\tinfra/agent/Dockerfile\t",
    );
    expect(await log()).toContain("build\t-f\tinfra/control-plane/Dockerfile\t");
    expect(await log()).toContain("local/control.ts\tdeploy\t");
    expect(await log()).not.toContain("/local-release.ts\t");
    await writeFile(join(directory, "docker.log"), "");
    await run(["up"]);
    expect(await log()).not.toContain("build\t-f\tinfra/");
    expect(await readFile(join(state, "retained-data"), "utf8")).toBe("notes and photos");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("does not start or rebuild services when the latest release cannot be resolved", async () => {
  const { directory, log, run } = await fixture();

  try {
    await expect(run(["up"], { LOCAL_TEST_LATEST_FAILURE: "1" })).rejects.toThrow();
    expect(await log()).not.toContain("compose\t");
    expect(await log()).not.toContain("build\t");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("keeps the current tooling and running platform when database compatibility fails", async () => {
  const { directory, log, run } = await fixture();

  try {
    await expect(run(["up"], { LOCAL_TEST_VERSION_FAILURE: "1" })).rejects.toThrow();
    expect(await log()).not.toContain("tag\twidefleet-local-tools:build\t");
    expect(await log()).not.toContain("stop\tagent\tcontrol-plane\t");
    expect(await log()).not.toContain("tools/initialize.ts\t");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it.each([["down"], ["reset", "--yes"], ["cli", "apps"], ["deploy"]])(
  "keeps %j independent of release lookup and obsolete mode files",
  async (...args) => {
    const { directory, state, log, run } = await fixture();

    try {
      await writeFile(join(state, "image-mode"), "");
      await run(args, { LOCAL_TEST_LATEST_FAILURE: "1" });
      expect(await log()).not.toContain("/local-release.ts\t");

      if (args[0] === "deploy") expect(await log()).toContain("version=1.2.3");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it.each([false, true])(
  "restores the saved deployment only if its fleet container is missing: existing=%s",
  async (exists) => {
    const { directory, state, log, run } = await fixture();

    try {
      await mkdir(join(state, "agent", fleet), { recursive: true });
      await run(["up"], { LOCAL_TEST_FLEET_EXISTS: exists ? "1" : "0" });
      expect(await log()).toContain(
        `local/control.ts\t${exists ? "deploy-if-needed" : "restore"}\t`,
      );

      if (exists) expect(await log()).toContain(`start\tplatform-fleet-${fleet}`);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it("replaces an outdated runtime before starting the agent and restores the saved app", async () => {
  const { directory, state, log, run } = await fixture();

  try {
    await mkdir(join(state, "agent", fleet), { recursive: true });
    await writeFile(join(state, "agent", fleet, "data"), "retained");
    await run(["up"], { LOCAL_TEST_FLEET_EXISTS: "1", LOCAL_TEST_RUNTIME_ID: "sha256:new" });
    const commands = await log();

    expect(commands).toContain(`stop\t--time\t30\tplatform-fleet-${fleet}`);
    expect(commands).toContain(`rm\tplatform-fleet-${fleet}`);
    expect(commands.indexOf(`rm\tplatform-fleet-${fleet}`)).toBeLessThan(
      commands.indexOf("up\t-d\tagent\t"),
    );
    expect(commands).toContain("local/control.ts\trestore\t");
    expect(commands).not.toContain(`start\tplatform-fleet-${fleet}`);
    expect(await readFile(join(state, "agent", fleet, "data"), "utf8")).toBe("retained");
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
