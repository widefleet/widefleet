import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { cliPlatforms } from "../../../../tools/cli-platforms.ts";

const execute = promisify(execFile);

const script = fileURLToPath(new URL("../../../../tools/publish-cli.sh", import.meta.url));

const packages = [...cliPlatforms.map((platform) => `widefleet-${platform.name}`), "widefleet"];

const fixture = async (registry = "https://registry.npmjs.org") => {
  const directory = await mkdtemp(join(tmpdir(), "widefleet-npm-publication-"));
  await mkdir(join(directory, "package"));

  for (const name of packages) {
    const platform = cliPlatforms.find((entry) => name === `widefleet-${entry.name}`);

    const manifest = {
      name,
      version: "0.3.0",
      repository: { url: "git+https://github.com/widefleet/widefleet.git" },
      publishConfig: { registry, access: "public" },
      ...(platform && {
        os: [platform.os],
        cpu: [platform.cpu],
        exports: { "./widefleet": `./widefleet${platform.extension}` },
        ...(platform.os === "linux" && { libc: ["glibc"] }),
      }),
      ...(name === "widefleet" && {
        bin: { widefleet: "./bin/widefleet.mjs" },
        optionalDependencies: Object.fromEntries(
          cliPlatforms.map((platform) => [`widefleet-${platform.name}`, "0.3.0"]),
        ),
      }),
    };

    await writeFile(join(directory, "package/package.json"), JSON.stringify(manifest));
    const archive = `${name}-0.3.0.tgz`;
    await execute("tar", ["-czf", archive, "package"], { cwd: directory });
    const bytes = await readFile(join(directory, archive));
    await writeFile(
      join(directory, `${archive}.sha256`),
      `${createHash("sha256").update(bytes).digest("hex")}  ${archive}\n`,
    );
    await writeFile(
      join(directory, `${name}.remote.json`),
      JSON.stringify({
        ...manifest,
        dist: { integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}` },
      }),
    );
  }

  await Promise.all(
    Object.entries({
      curl: `#!/bin/bash
set -euo pipefail
url=\${!#}
name=\${url%/*}
name=\${name##*/}
output=
while [[ $# -gt 0 ]]; do
  if [[ "$1" == --output ]]; then output=$2; break; fi
  shift
done
cp "$FIXTURE/$name.remote.json" "$output"
if [[ "\${MISMATCH_PACKAGE:-}" == "$name" ]]; then
  jq '.dist.integrity = "sha512-other"' "$output" > "$output.tmp"
  mv "$output.tmp" "$output"
fi
if [[ " \${EXISTING_PACKAGES:-} " == *" $name "* ]]; then
  printf 200
else
  printf '%s' "$HTTP_STATUS"
fi
`,
      npm: `#!/bin/bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FIXTURE/npm.log"
case "$1" in
  publish) ;;
  view)
    name=\${2%@*}
    if [[ "$3" == dist.integrity ]]; then
      jq '.dist.integrity' "$FIXTURE/$name.remote.json"
    else
      printf '%s\\n' '"git+https://github.com/widefleet/widefleet.git"'
    fi
    ;;
  *) exit 1 ;;
esac
`,
      pnpm: "#!/bin/sh\nexit 0\n",
      widefleet: `#!/bin/bash
set -euo pipefail
if [[ "$1" == --version ]]; then
  echo 'widefleet 0.3.0'
else
  mkdir -p "$2"
  touch "$2/.gitignore" "$2/pnpm-lock.yaml"
fi
`,
    }).map(([name, source]) => writeFile(join(directory, name), source, { mode: 0o755 })),
  );

  const run = (environment = {}) =>
    execute("bash", [script], {
      cwd: directory,
      env: {
        PATH: `${directory}:${process.env["PATH"] ?? "/usr/bin:/bin"}`,
        FIXTURE: directory,
        CLI_RELEASE_DIRECTORY: directory,
        GITHUB_STEP_SUMMARY: join(directory, "summary"),
        VERSION: "0.3.0",
        HTTP_STATUS: "404",
        ...environment,
      },
    });

  return { directory, run };
};

it("publishes every native package before the launcher with public access and provenance", async () => {
  const { directory, run } = await fixture();

  try {
    await run();
    expect(
      (await readFile(join(directory, "npm.log"), "utf8"))
        .split("\n")
        .filter((line) => line.startsWith("publish ")),
    ).toEqual(
      packages.map(
        (name) =>
          `publish ${directory}/${name}-0.3.0.tgz --registry=https://registry.npmjs.org --access=public --provenance --ignore-scripts`,
      ),
    );
    expect(await readFile(join(directory, "summary"), "utf8")).toContain(
      "Verified widefleet@0.3.0",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("accepts an identical existing version without publishing again", async () => {
  const { directory, run } = await fixture();

  try {
    await run({ HTTP_STATUS: "200" });
    expect(await readFile(join(directory, "npm.log"), "utf8")).not.toContain("publish ");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("finishes a partial publication without replacing existing native packages", async () => {
  const { directory, run } = await fixture();

  try {
    await run({ EXISTING_PACKAGES: "widefleet-linux-x64-gnu widefleet-darwin-arm64" });

    const publications = (await readFile(join(directory, "npm.log"), "utf8"))
      .split("\n")
      .filter((line) => line.startsWith("publish "));

    expect(publications).toHaveLength(3);
    expect(publications[0]).toContain("widefleet-darwin-x64-0.3.0.tgz");
    expect(publications[1]).toContain("widefleet-win32-x64-msvc-0.3.0.tgz");
    expect(publications[2]).toContain("widefleet-0.3.0.tgz");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("rejects a corrupt native archive before publishing any package", async () => {
  const { directory, run } = await fixture();

  try {
    await writeFile(join(directory, "widefleet-win32-x64-msvc-0.3.0.tgz"), "corrupt");
    await expect(run()).rejects.toThrow();
    await expect(readFile(join(directory, "npm.log"))).rejects.toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("rejects different existing bytes without attempting a replacement", async () => {
  const { directory, run } = await fixture();

  try {
    await expect(
      run({ EXISTING_PACKAGES: "widefleet", MISMATCH_PACKAGE: "widefleet" }),
    ).rejects.toThrow();
    await expect(readFile(join(directory, "npm.log"))).rejects.toThrow();
    await expect(readFile(join(directory, "summary"))).rejects.toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("does not treat registry failures as missing versions", async () => {
  const { directory, run } = await fixture();

  try {
    await expect(run({ HTTP_STATUS: "503" })).rejects.toThrow("npm version lookup failed");
    await expect(readFile(join(directory, "npm.log"))).rejects.toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("rejects an archive targeting another registry before publication", async () => {
  const { directory, run } = await fixture("https://registry.example.test");

  try {
    await expect(run()).rejects.toThrow();
    await expect(readFile(join(directory, "npm.log"))).rejects.toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
