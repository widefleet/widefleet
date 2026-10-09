import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execute = promisify(execFile);

const script = fileURLToPath(new URL("../../../../tools/publish-cli.sh", import.meta.url));

const fixture = async (registry = "https://registry.npmjs.org") => {
  const directory = await mkdtemp(join(tmpdir(), "widefleet-npm-publication-"));
  await mkdir(join(directory, "package"));
  await writeFile(
    join(directory, "package/package.json"),
    JSON.stringify({
      name: "widefleet",
      version: "0.3.0",
      repository: { url: "git+https://github.com/widefleet/widefleet.git" },
      publishConfig: { registry, access: "public" },
      os: ["linux"],
      cpu: ["x64"],
      libc: ["glibc"],
    }),
  );
  await execute("tar", ["-czf", "widefleet-0.3.0.tgz", "package"], { cwd: directory });
  const bytes = await readFile(join(directory, "widefleet-0.3.0.tgz"));
  await writeFile(
    join(directory, "widefleet-0.3.0.tgz.sha256"),
    `${createHash("sha256").update(bytes).digest("hex")}  widefleet-0.3.0.tgz\n`,
  );
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  await Promise.all(
    Object.entries({
      curl: `#!/bin/bash
set -euo pipefail
printf '%s' "$HTTP_STATUS"
`,
      npm: `#!/bin/bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FIXTURE/npm.log"
case "$1" in
  publish) ;;
  view)
    if [[ "$3" == dist.integrity ]]; then
      printf '"%s"\\n' "$INTEGRITY"
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
        INTEGRITY: integrity,
        ...environment,
      },
    });

  return { directory, run };
};

it("publishes the checked archive with public access and provenance, then verifies installation", async () => {
  const { directory, run } = await fixture();

  try {
    await run();
    expect(await readFile(join(directory, "npm.log"), "utf8")).toContain(
      `publish ${directory}/widefleet-0.3.0.tgz --registry=https://registry.npmjs.org --access=public --provenance --ignore-scripts`,
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

it("verifies an existing version in verify-only mode", async () => {
  const { directory, run } = await fixture();

  try {
    await run({ HTTP_STATUS: "200", VERIFY_ONLY: "true" });
    expect(await readFile(join(directory, "npm.log"), "utf8")).not.toContain("publish ");
    expect(await readFile(join(directory, "summary"), "utf8")).toContain(
      "Verified widefleet@0.3.0",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("refuses to publish a missing version in verify-only mode", async () => {
  const { directory, run } = await fixture();

  try {
    await expect(run({ VERIFY_ONLY: "true" })).rejects.toThrow();
    await expect(readFile(join(directory, "npm.log"))).rejects.toThrow();
    await expect(readFile(join(directory, "summary"))).rejects.toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("rejects different existing bytes without attempting a replacement", async () => {
  const { directory, run } = await fixture();

  try {
    await expect(run({ HTTP_STATUS: "200", INTEGRITY: "sha512-other" })).rejects.toThrow();
    expect(await readFile(join(directory, "npm.log"), "utf8")).not.toContain("publish ");
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
