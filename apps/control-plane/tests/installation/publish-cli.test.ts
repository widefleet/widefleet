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
        dist: {
          integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
          tarball: `https://registry.npmjs.org/${name}/-/${name}-0.3.0.tgz`,
        },
      }),
    );
  }

  await Promise.all(
    Object.entries({
      curl: `#!/bin/bash
set -euo pipefail
url=\${!#}
output=
accept=
while [[ $# -gt 0 ]]; do
  if [[ "$1" == --output ]]; then output=$2; fi
  if [[ "$1" == --header ]]; then accept=$2; fi
  shift
done
if [[ "$url" == */0.3.0 ]]; then
  name=\${url%/*}
  name=\${name##*/}
  kind=version
elif [[ "$url" == */-/*.tgz ]]; then
  name=\${url##*/}
  name=\${name%-0.3.0.tgz}
  kind=tarball
else
  name=\${url##*/}
  kind=full
  if [[ "$accept" == *application/vnd.npm.install-v1+json ]]; then kind=install; fi
fi
cp "$FIXTURE/$name.remote.json" "$output"
if [[ "\${MISMATCH_PACKAGE:-}" == "$name" ]]; then
  jq '.dist.integrity = "sha512-other"' "$output" > "$output.tmp"
  mv "$output.tmp" "$output"
fi
if [[ "$kind" == version ]]; then
  if [[ " \${EXISTING_PACKAGES:-} " == *" $name "* ]]; then
    printf 200
  else
    printf '%s' "$HTTP_STATUS"
  fi
  exit
fi
count=0
if [[ -f "$FIXTURE/$name.$kind.count" ]]; then count=$(cat "$FIXTURE/$name.$kind.count"); fi
count=$((count + 1))
printf '%s' "$count" > "$FIXTURE/$name.$kind.count"
printf 'check %s %s\\n' "$name" "$kind" >> "$FIXTURE/events.log"
if [[ "$name" == widefleet-linux-x64-gnu ]]; then
  if [[ "$kind" == full ]]; then
    if [[ -n "\${AVAILABILITY_HTTP_STATUS:-}" ]]; then printf '%s' "$AVAILABILITY_HTTP_STATUS"; exit; fi
    if [[ -n "\${TRANSIENT_STATUS:-}" && "$count" == 1 ]]; then
      if [[ "$TRANSIENT_STATUS" == 000 ]]; then exit 7; fi
      printf '%s' "$TRANSIENT_STATUS"; exit
    fi
    if ((count <= \${REGISTRY_404_POLLS:-0})); then printf 404; exit; fi
  fi
  if [[ "$kind" == install ]] && ((count <= \${INSTALL_METADATA_POLLS:-0})); then
    echo '{"versions":{}}' > "$output"; printf 200; exit
  fi
  if [[ "$kind" == tarball ]] && ((count <= \${TARBALL_404_POLLS:-0})); then printf 404; exit; fi
  if [[ "\${WRONG_INTEGRITY:-}" == "$kind" ]]; then
    jq '.dist.integrity = "sha512-other"' "$output" > "$output.tmp"
    mv "$output.tmp" "$output"
  fi
  if [[ "\${WRONG_REPOSITORY:-false}" == true ]]; then
    jq '.repository.url = "git+https://example.test/other.git"' "$output" > "$output.tmp"
    mv "$output.tmp" "$output"
  fi
fi
if [[ "$kind" == tarball ]]; then
  printf 'available %s\\n' "$name" >> "$FIXTURE/events.log"
else
  jq '{versions: {"0.3.0": .}}' "$output" > "$output.tmp"
  mv "$output.tmp" "$output"
fi
printf 200
`,
      npm: `#!/bin/bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FIXTURE/npm.log"
case "$1" in
  publish)
    name=\${2##*/}
    name=\${name%-0.3.0.tgz}
    printf 'publish %s\\n' "$name" >> "$FIXTURE/events.log"
    test "\${PUBLISH_FAIL:-false}" != true
    ;;
  *) exit 1 ;;
esac
`,
      pnpm: '#!/bin/sh\nprintf "install\\n" >> "$FIXTURE/events.log"\n',
      sleep: '#!/bin/sh\nprintf "%s\\n" "$*" >> "$FIXTURE/sleep.log"\n/bin/sleep 0.01\n',
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
      timeout: 10_000,
      env: {
        PATH: `${directory}:${process.env["PATH"] ?? "/usr/bin:/bin"}`,
        FIXTURE: directory,
        CLI_RELEASE_DIRECTORY: directory,
        GITHUB_STEP_SUMMARY: join(directory, "summary"),
        VERSION: "0.3.0",
        HTTP_STATUS: "404",
        NPM_PROPAGATION_TIMEOUT_SECONDS: "2",
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
    await expect(readFile(join(directory, "npm.log"))).rejects.toThrow();
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

it("waits for metadata and tarballs before publishing the launcher without repeating uploads", async () => {
  const { directory, run } = await fixture();

  try {
    await run({ REGISTRY_404_POLLS: "2", INSTALL_METADATA_POLLS: "2", TARBALL_404_POLLS: "2" });
    const events = (await readFile(join(directory, "events.log"), "utf8")).trim().split("\n");

    expect(events.filter((event) => event.startsWith("publish "))).toEqual(
      packages.map((name) => `publish ${name}`),
    );

    for (const name of packages.slice(0, -1)) {
      expect(events).toContain(`available ${name}`);
      expect(events.indexOf(`available ${name}`)).toBeLessThan(events.indexOf("publish widefleet"));
    }

    expect(events.at(-1)).toBe("install");
    expect(await readFile(join(directory, "widefleet-linux-x64-gnu.full.count"), "utf8")).toBe("7");
    expect(await readFile(join(directory, "widefleet-linux-x64-gnu.install.count"), "utf8")).toBe(
      "5",
    );
    expect(await readFile(join(directory, "widefleet-linux-x64-gnu.tarball.count"), "utf8")).toBe(
      "3",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it.each(["000", "408", "429", "503"])(
  "recovers from transient availability failure %s",
  async (status) => {
    const { directory, run } = await fixture();

    try {
      await run({ TRANSIENT_STATUS: status });
      const events = (await readFile(join(directory, "events.log"), "utf8")).trim().split("\n");

      expect(events.filter((event) => event === "publish widefleet-linux-x64-gnu")).toHaveLength(1);
      expect(events.at(-1)).toBe("install");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it("times out without republishing or publishing a launcher with unavailable dependencies", async () => {
  const { directory, run } = await fixture();

  try {
    await expect(
      run({ AVAILABILITY_HTTP_STATUS: "404", NPM_PROPAGATION_TIMEOUT_SECONDS: "1" }),
    ).rejects.toThrow(
      "Timed out after 1s waiting for npm availability: widefleet-linux-x64-gnu@0.3.0",
    );
    const events = (await readFile(join(directory, "events.log"), "utf8")).trim().split("\n");

    expect(events.filter((event) => event.startsWith("publish "))).toEqual([
      "publish widefleet-linux-x64-gnu",
    ]);
    expect(events).not.toContain("install");
    await expect(readFile(join(directory, "summary"))).rejects.toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it.each([
  { environment: { AVAILABILITY_HTTP_STATUS: "401" }, error: "HTTP 401" },
  { environment: { AVAILABILITY_HTTP_STATUS: "403" }, error: "HTTP 403" },
  { environment: { WRONG_INTEGRITY: "full" }, error: "npm integrity mismatch" },
  { environment: { WRONG_INTEGRITY: "install" }, error: "npm integrity mismatch" },
  { environment: { WRONG_REPOSITORY: "true" }, error: "npm repository mismatch" },
])("fails immediately on $error during availability checks", async ({ environment, error }) => {
  const { directory, run } = await fixture();

  try {
    await expect(run(environment)).rejects.toThrow(error);
    await expect(readFile(join(directory, "sleep.log"))).rejects.toThrow();
    const events = (await readFile(join(directory, "events.log"), "utf8")).trim().split("\n");

    expect(events.filter((event) => event.startsWith("publish "))).toEqual([
      "publish widefleet-linux-x64-gnu",
    ]);
    expect(events).not.toContain("install");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("stops on a publication failure instead of waiting or retrying the upload", async () => {
  const { directory, run } = await fixture();

  try {
    await expect(run({ PUBLISH_FAIL: "true" })).rejects.toThrow();
    expect((await readFile(join(directory, "events.log"), "utf8")).trim()).toBe(
      "publish widefleet-linux-x64-gnu",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
