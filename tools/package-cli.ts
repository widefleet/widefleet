import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { build } from "esbuild";
import { cliPlatform, cliPlatforms } from "./cli-platforms.ts";
import { esbuildBinary, runPnpm } from "./cli-tools.ts";

const execute = promisify(execFile);

const root = fileURLToPath(new URL("../", import.meta.url));

const { values } = parseArgs({
  options: { binary: { type: "string" }, output: { type: "string", default: ".local/releases" } },
});

const platform = cliPlatform(process.platform, process.arch);

const executableName = `widefleet${platform.extension}`;

const bundlerName = `esbuild${platform.extension}`;

if (!values.binary)
  await execute(
    process.platform === "win32" ? "cargo" : "bash",
    [
      ...(process.platform === "win32" ? [] : ["tools/cargo.sh"]),
      "build",
      "--locked",
      "--release",
      "-p",
      "platform-cli",
    ],
    {
      cwd: root,
      maxBuffer: 16 * 1024 * 1024,
    },
  );

const binary = resolve(root, values.binary ?? `target/release/${executableName}`);

const version = (await execute(binary, ["--version"])).stdout.trim().replace(/^widefleet /, "");

if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Unexpected CLI version output");

const esbuild = esbuildBinary();

const esbuildVersion = (await execute(esbuild, ["--version"])).stdout.trim();

const name = `widefleet-cli-${version}-${platform.os}-${platform.cpu}`;

const output = resolve(root, values.output);

const release = join(output, name);

await mkdir(output, { recursive: true });

// Refuse to replace an existing release, including locally produced artifacts.
await mkdir(release);

await copyFile(binary, join(release, executableName));

await copyFile(esbuild, join(release, bundlerName));

await chmod(join(release, executableName), 0o755);

await chmod(join(release, bundlerName), 0o755);

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

for (const file of [".gitattributes", ".gitignore", ".oxlintrc.json", ".oxfmtrc.json"])
  await copyFile(join(root, file), join(template, file));

await cp(join(root, "tools/oxlint"), join(template, "tools/oxlint"), { recursive: true });

await writeFile(
  join(template, "pnpm-workspace.yaml"),
  "packages: []\nstrictPeerDependencies: true\nallowBuilds:\n  esbuild: true\n  workerd: true\n",
);

// Verify the committed independent lockfile without resolving new versions during packaging.
await runPnpm(["install", "--lockfile-only", "--frozen-lockfile", "--ignore-scripts"], template);

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

const metadata = {
  name: `widefleet-${platform.name}`,
  version,
  description: "Widefleet CLI with its Worker bundler and app starter",
  license: "MIT",
  exports: { "./widefleet": `./${executableName}`, "./package.json": "./package.json" },
  os: [platform.os],
  cpu: [platform.cpu],
  files: [
    executableName,
    bundlerName,
    "release.json",
    "starter",
    "licenses",
    "README.md",
    "LICENSE",
  ],
  repository: { type: "git", url: "git+https://github.com/widefleet/widefleet.git" },
  publishConfig: { registry: "https://registry.npmjs.org", access: "public" },
};

if (platform.os === "linux") Object.assign(metadata, { libc: ["glibc"] });

await writeFile(join(npmPackage, "package.json"), JSON.stringify(metadata, null, 2) + "\n");

const launcherDirectory = join(output, `${name}-launcher`);

const launcherPackage = join(launcherDirectory, "package");

await mkdir(launcherDirectory);

await mkdir(join(launcherPackage, "bin"), { recursive: true });

await build({
  entryPoints: [join(root, "tools/cli-launcher.ts")],
  outfile: join(launcherPackage, "bin/widefleet.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node26",
});

await chmod(join(launcherPackage, "bin/widefleet.mjs"), 0o755);

await copyFile(join(root, "LICENSE"), join(launcherPackage, "LICENSE"));

await copyFile(join(release, "README.md"), join(launcherPackage, "README.md"));

await writeFile(
  join(launcherPackage, "package.json"),
  JSON.stringify(
    {
      name: "widefleet",
      version,
      description: "Widefleet CLI with its Worker bundler and app starter",
      license: "MIT",
      type: "module",
      bin: { widefleet: "./bin/widefleet.mjs" },
      engines: { node: ">=26" },
      os: ["linux", "darwin", "win32"],
      cpu: ["x64", "arm64"],
      files: ["bin", "README.md", "LICENSE"],
      optionalDependencies: Object.fromEntries(
        cliPlatforms.map((entry) => [`widefleet-${entry.name}`, version]),
      ),
      repository: metadata.repository,
      publishConfig: metadata.publishConfig,
    },
    null,
    2,
  ) + "\n",
);

// Pack the explicit release tree directly: npm pack's ignore rules would remove
// starter files such as .gitignore. Both archives must preserve the whole template.
for (const item of [
  { file: archive, directory: output, entry: name },
  {
    file: `widefleet-${platform.name}-${version}.tgz`,
    directory: npmDirectory,
    entry: "package",
  },
  { file: `widefleet-${version}.tgz`, directory: launcherDirectory, entry: "package" },
]) {
  // A second target may share this output directory; never replace existing artifacts.
  await writeFile(join(output, item.file), "", { flag: "wx" });

  await execute(
    "tar",
    [
      ...(process.platform === "linux"
        ? ["--sort=name", "--mtime=@0", "--owner=0", "--group=0", "--numeric-owner"]
        : []),
      "-czf",
      item.file,
      "-C",
      item.directory,
      item.entry,
    ],
    { cwd: output },
  );

  const digest = createHash("sha256")
    .update(await readFile(join(output, item.file)))
    .digest("hex");

  await writeFile(join(output, `${item.file}.sha256`), `${digest}  ${item.file}\n`);
}

// Keep stdout compatible with callers that consume the release archive path.
console.info(join(output, archive));
