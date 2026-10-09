import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execute = promisify(execFile);

const script = fileURLToPath(
  new URL("../../../../tools/upload-release-assets.sh", import.meta.url),
);

const fixture = async (existing: Record<string, string> = {}) => {
  const directory = await mkdtemp(join(tmpdir(), "widefleet-release-assets-"));
  await mkdir(join(directory, "remote"));
  await mkdir(join(directory, "local"));

  for (const [name, content] of Object.entries(existing))
    await writeFile(join(directory, "remote", name), content);
  await writeFile(
    join(directory, "metadata.json"),
    JSON.stringify({
      tagName: "v0.3.0",
      isDraft: true,
      isPrerelease: false,
      assets: Object.keys(existing).map((name) => ({ name })),
    }),
  );
  await writeFile(
    join(directory, "gh"),
    `#!/bin/bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FIXTURE/gh.log"
case "$1" in
  release)
    operation=$2
    test "$3" = v0.3.0
    shift 3
    case "$operation" in
      view)
        test "\${LOOKUP_FAIL:-false}" != true
        cat "$FIXTURE/metadata.json"
        ;;
      upload)
        source=$1
        test "$2" = --repo
        test "$3" = widefleet/widefleet
        target="$FIXTURE/remote/$(basename "$source")"
        test ! -f "$target"
        cp "$source" "$target"
        ;;
      download)
        test "$1" = --repo
        test "$2" = widefleet/widefleet
        test "$3" = --pattern
        test "$5" = --dir
        cp "$FIXTURE/remote/$4" "$6/$4"
        if [[ "\${CORRUPT_DOWNLOAD:-false}" == true ]]; then
          echo corrupt >> "$6/$4"
        fi
        ;;
      *) exit 1 ;;
    esac
    ;;
  *) exit 1 ;;
esac
`,
    { mode: 0o755 },
  );

  const assets = ["widefleet-0.3.0.tgz", "widefleet-0.3.0.tgz.sha256"];

  for (const name of assets) await writeFile(join(directory, "local", name), name);

  const run = (environment = {}) =>
    execute("bash", [script, ...assets.map((name) => join(directory, "local", name))], {
      cwd: directory,
      env: {
        PATH: `${directory}:${process.env["PATH"] ?? "/usr/bin:/bin"}`,
        FIXTURE: directory,
        GITHUB_REPOSITORY: "widefleet/widefleet",
        RELEASE_TAG: "v0.3.0",
        ...environment,
      },
    });

  return { directory, assets, run };
};

it("uploads missing draft attachments and verifies their downloaded bytes", async () => {
  const { directory, assets, run } = await fixture();

  try {
    await run();

    for (const name of assets)
      expect(await readFile(join(directory, "remote", name), "utf8")).toBe(name);
    expect(
      (await readFile(join(directory, "gh.log"), "utf8")).match(/release download/g),
    ).toHaveLength(2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("reuses an identical attachment and uploads only the missing one", async () => {
  const { directory, run } = await fixture({ "widefleet-0.3.0.tgz": "widefleet-0.3.0.tgz" });

  try {
    await run();
    const commands = await readFile(join(directory, "gh.log"), "utf8");
    expect(commands.match(/release upload/g)).toHaveLength(1);
    expect(commands).toContain(
      `release upload v0.3.0 ${directory}/local/widefleet-0.3.0.tgz.sha256`,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("rejects conflicting existing attachments before uploading any missing file", async () => {
  const { directory, run } = await fixture({ "widefleet-0.3.0.tgz.sha256": "different" });

  try {
    await expect(run()).rejects.toThrow();
    expect(await readFile(join(directory, "gh.log"), "utf8")).not.toContain("release upload");
    expect(await readdir(join(directory, "remote"))).toEqual(["widefleet-0.3.0.tgz.sha256"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("fails a corrupt download instead of reporting a successful attachment", async () => {
  const { directory, run } = await fixture();

  try {
    await expect(run({ CORRUPT_DOWNLOAD: "true" })).rejects.toThrow();
    expect(await readdir(join(directory, "remote"))).toEqual(["widefleet-0.3.0.tgz"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("does not treat a failed release lookup as missing attachments", async () => {
  const { directory, run } = await fixture();

  try {
    await expect(run({ LOOKUP_FAIL: "true" })).rejects.toThrow();
    expect(await readdir(join(directory, "remote"))).toEqual([]);
    expect(await readFile(join(directory, "gh.log"), "utf8")).not.toContain("release upload");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("does not add missing assets to a published release", async () => {
  const { directory, run } = await fixture();

  try {
    await writeFile(
      join(directory, "metadata.json"),
      JSON.stringify({
        tagName: "v0.3.0",
        isDraft: false,
        isPrerelease: false,
        assets: [],
      }),
    );
    await expect(run()).rejects.toThrow();
    expect(await readFile(join(directory, "gh.log"), "utf8")).not.toContain("release upload");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
