import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";

const version = process.argv[2];

if (!version || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Expected a release version");

const name = `widefleet-cli-${version}-linux-x64`;

const url = `https://github.com/widefleet/widefleet/releases/download/v${version}/${name}.tar.gz`;

const [archive, checksum] = await Promise.all([
  fetch(url, { signal: AbortSignal.timeout(120_000) }),
  fetch(`${url}.sha256`, { signal: AbortSignal.timeout(30_000) }),
]);

if (!archive.ok || !checksum.ok) throw new Error(`Widefleet ${version} CLI download failed`);

const bytes = Buffer.from(await archive.arrayBuffer());

if (createHash("sha256").update(bytes).digest("hex") !== (await checksum.text()).split(/\s+/)[0])
  throw new Error("CLI archive checksum mismatch");

await mkdir("/opt/widefleet", { recursive: true });

await writeFile("/tmp/widefleet-cli.tar.gz", bytes);

await promisify(execFile)("tar", ["-xzf", "/tmp/widefleet-cli.tar.gz", "-C", "/opt/widefleet"]);

await rm("/tmp/widefleet-cli.tar.gz");

console.info(`/opt/widefleet/${name}/widefleet`);
