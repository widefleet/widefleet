import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execute = promisify(execFile);

const script = fileURLToPath(new URL("../../../../tools/test-release-images.sh", import.meta.url));

const fixture = async () => {
  const directory = await mkdtemp(join(tmpdir(), "widefleet-runtime-download-"));
  const source = join(directory, "packages/app-runtime/dist");
  const output = join(directory, "download");
  await mkdir(source, { recursive: true });
  const content = JSON.stringify({ version: "0.4.1", modules: [] });
  await writeFile(join(source, "release.json"), content);
  await writeFile(join(directory, "runtime.json"), content);
  await writeFile(join(directory, "control-plane.json"), content);
  await writeFile(
    join(directory, "docker"),
    `#!/bin/bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FIXTURE/docker.log"
case "$*" in
  *"--entrypoint cat "*) cat "$FIXTURE/runtime.json" ;;
  *"--entrypoint node "*) cat "$FIXTURE/control-plane.json" ;;
  *"--entrypoint widefleet "*) echo 'widefleet 0.4.1' ;;
  *" --version") echo 'platform-agent 0.4.1' ;;
  "compose "*) ;;
  *) exit 1 ;;
esac
`,
    { mode: 0o755 },
  );
  await writeFile(join(directory, "pnpm"), "#!/bin/bash\nexit 0\n", { mode: 0o755 });

  const run = () =>
    execute("bash", [script], {
      cwd: directory,
      env: {
        PATH: `${directory}:${process.env["PATH"] ?? "/usr/bin:/bin"}`,
        FIXTURE: directory,
        VERSION: "0.4.1",
        RELEASE_RUNTIME: output,
      },
    });

  return { directory, source, output, content, run };
};

it("packages the runtime bytes shared by the source and both release images", async () => {
  const { directory, output, content, run } = await fixture();

  try {
    await run();
    expect(await readFile(join(output, "release.json"), "utf8")).toBe(content);
    await execute("sha256sum", ["--check", "release.json.sha256"], { cwd: output });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it.each(["runtime.json", "control-plane.json"])(
  "rejects differing runtime bytes in %s",
  async (name) => {
    const { directory, output, run } = await fixture();

    try {
      await writeFile(
        join(directory, name),
        JSON.stringify({ version: "0.4.1", modules: ["other"] }),
      );
      await expect(run()).rejects.toThrow();
      await expect(readFile(join(output, "release.json.sha256"))).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it("rejects matching runtime packages with a different product version", async () => {
  const { directory, source, output, run } = await fixture();

  try {
    const content = JSON.stringify({ version: "0.3.0", modules: [] });
    await writeFile(join(source, "release.json"), content);
    await writeFile(join(directory, "runtime.json"), content);
    await writeFile(join(directory, "control-plane.json"), content);
    await expect(run()).rejects.toThrow();
    await expect(readFile(join(output, "release.json.sha256"))).rejects.toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
