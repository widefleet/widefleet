import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, cp, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";

const execute = promisify(execFile);

const root = fileURLToPath(new URL("../", import.meta.url));

const { values } = parseArgs({
  options: { binary: { type: "string" }, output: { type: "string", default: ".local/releases" } },
});

// Release support is intentionally limited to the platform exercised by runtime tests.
if (process.platform !== "linux" || process.arch !== "x64")
  throw new Error("CLI release packaging currently supports Linux x64 (glibc)");

if (!values.binary)
  await execute(
    "bash",
    ["tools/cargo.sh", "build", "--locked", "--release", "-p", "platform-cli"],
    {
      cwd: root,
      maxBuffer: 16 * 1024 * 1024,
    },
  );

const binary = resolve(root, values.binary ?? "target/release/widefleet");

const version = (await execute(binary, ["--version"])).stdout.trim().replace(/^widefleet /, "");

if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Unexpected CLI version output");

const esbuild = await realpath(fileURLToPath(import.meta.resolve("esbuild/bin/esbuild")));

const esbuildVersion = (await execute(esbuild, ["--version"])).stdout.trim();

const name = `widefleet-cli-${version}-linux-x64`;

const output = resolve(root, values.output);

const release = join(output, name);

await mkdir(output, { recursive: true });

// Refuse to replace an existing release, including locally produced artifacts.
await mkdir(release);

await copyFile(binary, join(release, "widefleet"));

await copyFile(esbuild, join(release, "esbuild"));

await chmod(join(release, "widefleet"), 0o755);

await chmod(join(release, "esbuild"), 0o755);

await writeFile(
  join(release, "release.json"),
  JSON.stringify({ format: 1, version, esbuild_version: esbuildVersion }, null, 2) + "\n",
);

const template = join(release, "starter");

await mkdir(template);

for (const file of [
  "src",
  "tools",
  "package.json",
  "pnpm-lock.yaml",
  "tsconfig.json",
  "vite.config.ts",
  "wrangler.jsonc",
  "README.md",
  "AGENTS.md",
  "LICENSE",
])
  await cp(join(root, "starters/sveltekit", file), join(template, file), { recursive: true });

for (const file of [".gitignore", ".oxlintrc.json", ".oxfmtrc.json"])
  await copyFile(join(root, file), join(template, file));

await cp(join(root, "tools/oxlint"), join(template, "tools/oxlint"), { recursive: true });

await writeFile(
  join(template, "pnpm-workspace.yaml"),
  "packages: []\nstrictPeerDependencies: true\nallowBuilds:\n  esbuild: true\n  workerd: true\n",
);

// Verify the committed independent lockfile without resolving new versions during packaging.
await execute("pnpm", ["install", "--lockfile-only", "--frozen-lockfile", "--ignore-scripts"], {
  cwd: template,
  maxBuffer: 8 * 1024 * 1024,
});

await mkdir(join(release, "licenses"));

await copyFile(
  join(dirname(fileURLToPath(import.meta.resolve("esbuild/package.json"))), "LICENSE.md"),
  join(release, "licenses/esbuild.txt"),
);

const installationGuide = await readFile(
  join(root, "apps/docs/docs/getting-started/installation.md"),
  "utf8",
);

await writeFile(
  join(release, "README.md"),
  installationGuide
    .replace(/^---\n[\s\S]*?\n---\n/, "# Install the Widefleet CLI\n")
    .replaceAll("](/", "](https://widefleet.com/docs/"),
);

await copyFile(join(root, "LICENSE"), join(release, "LICENSE"));

const archive = `${name}.tar.gz`;

const npmDirectory = join(output, `${name}-npm`);

await mkdir(npmDirectory);

const npmPackage = join(npmDirectory, "package");

await cp(release, npmPackage, { recursive: true });

await writeFile(
  join(npmPackage, "package.json"),
  JSON.stringify(
    {
      name: "@getmendra/widefleet",
      version,
      description: "Widefleet CLI with its Worker bundler and app starter",
      license: "MIT",
      bin: { widefleet: "./widefleet" },
      os: ["linux"],
      cpu: ["x64"],
      libc: ["glibc"],
      files: [
        "widefleet",
        "esbuild",
        "release.json",
        "starter",
        "licenses",
        "README.md",
        "LICENSE",
      ],
      repository: { type: "git", url: "git+https://github.com/getmendra/widefleet.git" },
      publishConfig: { registry: "https://npm.pkg.github.com", access: "restricted" },
    },
    null,
    2,
  ) + "\n",
);

// Pack the explicit release tree directly: npm pack's ignore rules would remove
// starter files such as .gitignore. Both archives must preserve the whole template.
for (const item of [
  { file: archive, directory: output, entry: name },
  { file: `getmendra-widefleet-${version}.tgz`, directory: npmDirectory, entry: "package" },
]) {
  await execute("tar", [
    "--sort=name",
    "--mtime=@0",
    "--owner=0",
    "--group=0",
    "--numeric-owner",
    "-czf",
    join(output, item.file),
    "-C",
    item.directory,
    item.entry,
  ]);

  const digest = createHash("sha256")
    .update(await readFile(join(output, item.file)))
    .digest("hex");

  await writeFile(join(output, `${item.file}.sha256`), `${digest}  ${item.file}\n`);
}

// Keep stdout compatible with callers that consume the release archive path.
console.info(join(output, archive));
