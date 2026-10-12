import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execute = promisify(execFile);

const root = fileURLToPath(new URL("../../../../", import.meta.url));

const fixture = async () => {
  const directory = await mkdtemp(join(tmpdir(), "widefleet-release-binaries-"));
  const built = join(directory, "built");
  const downloaded = join(directory, "downloaded");
  await mkdir(join(built, "source/target/release"), { recursive: true });
  await mkdir(downloaded);
  const { stdout: revision } = await execute("git", ["rev-parse", "HEAD"], { cwd: root });
  await writeFile(join(built, "revision"), revision);
  const checksums = [];

  for (const name of ["platform-agent", "widefleet"]) {
    const path = `source/target/release/${name}`;
    const content = `#!/bin/sh\necho ${name}\n`;
    await writeFile(join(built, path), content, { mode: 0o755 });
    checksums.push(`${createHash("sha256").update(content).digest("hex")}  ${path}\n`);
  }

  await writeFile(join(built, "SHA256SUMS"), checksums.join(""));

  const pack = () =>
    execute(
      "tar",
      ["-cf", join(downloaded, "release-binaries.tar"), "revision", "SHA256SUMS", "source"],
      {
        cwd: built,
      },
    );

  const run = () =>
    execute("bash", ["tools/load-release-binaries.sh"], {
      cwd: root,
      env: { ...process.env, RELEASE_BINARIES: downloaded },
    });

  return { directory, built, downloaded, pack, run };
};

it("preserves the exact agent and CLI bytes and executable modes across artifact transport", async () => {
  const { directory, built, downloaded, pack, run } = await fixture();

  try {
    await pack();
    await run();

    for (const name of ["platform-agent", "widefleet"]) {
      const path = `source/target/release/${name}`;
      expect(await readFile(join(downloaded, path))).toEqual(await readFile(join(built, path)));
      await access(join(downloaded, path), constants.X_OK);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("rejects binaries from another source commit", async () => {
  const { directory, built, pack, run } = await fixture();

  try {
    await writeFile(join(built, "revision"), "0".repeat(40));
    await pack();
    await expect(run()).rejects.toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it.each(["platform-agent", "widefleet"])("rejects modified %s bytes", async (name) => {
  const { directory, built, pack, run } = await fixture();

  try {
    await writeFile(join(built, `source/target/release/${name}`), "corrupt");
    await pack();
    await expect(run()).rejects.toThrow("checksum did NOT match");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("rejects an archive that lost executable permissions", async () => {
  const { directory, built, pack, run } = await fixture();

  try {
    await chmod(join(built, "source/target/release/platform-agent"), 0o644);
    await pack();
    await expect(run()).rejects.toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
