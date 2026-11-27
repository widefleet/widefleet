// Prepares dist/cli, the Widefleet CLI release that the build image runs. The
// binary must be built for Debian bookworm on linux/amd64, as
// tools/build-release-binaries.sh builds it; esbuild and the starters come from
// this checkout, as in a published release.
import { execFile } from "node:child_process";
import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import process from "node:process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";

const execute = promisify(execFile);

const { values } = parseArgs({ options: { binary: { type: "string" } } });

if (!values.binary) throw new Error("Pass --binary, the widefleet binary for linux/amd64");

// pnpm runs this script in the package directory; paths are relative to where it was started.
const binary = resolve(process.env["INIT_CWD"] ?? process.cwd(), values.binary);

const packaged = await mkdtemp(join(tmpdir(), "widefleet-ci-cli-"));

try {
  await execute(
    process.execPath,
    [
      fileURLToPath(new URL("../../tools/package-cli.ts", import.meta.url).href),
      "--binary",
      binary,
      "--output",
      packaged,
    ],
    { maxBuffer: 16 * 1024 * 1024 },
  );

  const release = (await readdir(packaged, { withFileTypes: true })).find(
    (entry) => entry.isDirectory() && entry.name.endsWith("-linux-x64"),
  );

  if (!release) throw new Error("The CLI release for linux-x64 was not packaged");

  const output = fileURLToPath(new URL("dist/cli/", import.meta.url).href);

  await rm(output, { recursive: true, force: true });
  await cp(join(packaged, release.name), output, { recursive: true });
  console.info(`Prepared ${output}`);
} finally {
  await rm(packaged, { recursive: true, force: true });
}
