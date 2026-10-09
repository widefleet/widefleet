import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execute = promisify(execFile);

const tools = fileURLToPath(new URL("../../../../tools/", import.meta.url));

const fixture = async () => {
  const directory = await mkdtemp(join(tmpdir(), "widefleet-release-publication-"));
  const local = join(directory, "local");
  await mkdir(local);
  await mkdir(join(directory, "remote"));

  const assets = [
    "widefleet-0.3.0.tgz",
    "widefleet-cli-0.3.0-linux-x64.tar.gz",
    "widefleet-images-0.3.0.env",
  ];

  for (const name of assets) {
    await writeFile(join(local, name), name);
    const hash = createHash("sha256").update(name).digest("hex");
    await writeFile(join(local, `${name}.sha256`), `${hash}  ${name}\n`);
  }

  await writeFile(join(directory, "metadata.json"), "null");
  await writeFile(
    join(directory, "gh"),
    `#!/bin/bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FIXTURE/gh.log"
if [[ "$1" == api ]]; then
  test "$2" = graphql
  test "\${LOOKUP_FAIL:-false}" != true
  jq '{data: {repository: {release: .}}}' "$FIXTURE/metadata.json"
  exit
fi
test "$1" = release
operation=$2
test "$3" = v0.3.0
shift 3
case "$operation" in
  create)
    [[ " $* " == *" --draft "* ]]
    [[ " $* " == *" --verify-tag "* ]]
    jq -e '. == null' "$FIXTURE/metadata.json" > /dev/null
    printf '%s' '{"tagName":"v0.3.0","isDraft":true,"isPrerelease":false,"assets":[]}' > "$FIXTURE/metadata.json"
    ;;
  view)
    if [[ " $* " == *" --jq .isDraft "* ]]; then
      jq .isDraft "$FIXTURE/metadata.json"
    else
      cat "$FIXTURE/metadata.json"
    fi
    ;;
  upload)
    jq -e '.isDraft == true' "$FIXTURE/metadata.json" > /dev/null
    name=$(basename "$1")
    test "$name" != "\${FAIL_UPLOAD:-}"
    test ! -f "$FIXTURE/remote/$name"
    cp "$1" "$FIXTURE/remote/$name"
    jq --arg name "$name" '.assets += [{name: $name}]' "$FIXTURE/metadata.json" > "$FIXTURE/updated.json"
    mv "$FIXTURE/updated.json" "$FIXTURE/metadata.json"
    ;;
  download)
    test "$3" = --pattern
    test "$5" = --dir
    cp "$FIXTURE/remote/$4" "$6/$4"
    ;;
  edit)
    [[ " $* " == *" --draft=false "* ]]
    [[ " $* " == *" --verify-tag "* ]]
    jq -e '.isDraft == true and (.assets | length) == 6' "$FIXTURE/metadata.json" > /dev/null
    jq '.isDraft = false' "$FIXTURE/metadata.json" > "$FIXTURE/updated.json"
    mv "$FIXTURE/updated.json" "$FIXTURE/metadata.json"
    # Simulate a server-side success followed by a lost response.
    test "\${FAIL_AFTER_PUBLISH:-false}" != true
    ;;
  *) exit 1 ;;
esac
`,
    { mode: 0o755 },
  );

  const run = (script: string, environment = {}) =>
    execute("bash", [join(tools, script)], {
      cwd: directory,
      env: {
        PATH: `${directory}:${process.env["PATH"] ?? "/usr/bin:/bin"}`,
        FIXTURE: directory,
        GITHUB_REPOSITORY: "widefleet/widefleet",
        RELEASE_TAG: "v0.3.0",
        VERSION: "0.3.0",
        REVISION: "a".repeat(40),
        CLI_RELEASE_DIRECTORY: local,
        RELEASE_IMAGES: local,
        GITHUB_STEP_SUMMARY: join(directory, "summary"),
        ...environment,
      },
    });

  return { directory, local, run };
};

it("creates a draft and publishes only after all six verified assets are attached", async () => {
  const { directory, run } = await fixture();

  try {
    await run("prepare-release.sh");
    expect(JSON.parse(await readFile(join(directory, "metadata.json"), "utf8"))).toMatchObject({
      isDraft: true,
      assets: [],
    });
    await run("publish-github-release.sh");
    expect(JSON.parse(await readFile(join(directory, "metadata.json"), "utf8"))).toMatchObject({
      isDraft: false,
    });
    expect(await readdir(join(directory, "remote"))).toHaveLength(6);
    const commands = await readFile(join(directory, "gh.log"), "utf8");
    expect(commands.lastIndexOf("release download")).toBeLessThan(commands.indexOf("release edit"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("preserves an existing draft and its release notes", async () => {
  const { directory, run } = await fixture();

  try {
    const metadata = JSON.stringify({
      tagName: "v0.3.0",
      isDraft: true,
      isPrerelease: false,
      body: "Release notes",
    });

    await writeFile(join(directory, "metadata.json"), metadata);
    await run("prepare-release.sh");
    expect(await readFile(join(directory, "metadata.json"), "utf8")).toBe(metadata);
    expect(await readFile(join(directory, "gh.log"), "utf8")).not.toContain("release create");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it.each([{ isDraft: false }, { isPrerelease: true }, { tagName: "v0.2.0" }])(
  "rejects an existing release that cannot be prepared: %j",
  async (override) => {
    const { directory, run } = await fixture();

    try {
      await writeFile(
        join(directory, "metadata.json"),
        JSON.stringify({
          tagName: "v0.3.0",
          isDraft: true,
          isPrerelease: false,
          ...override,
        }),
      );
      await expect(run("prepare-release.sh")).rejects.toThrow();
      expect(await readFile(join(directory, "gh.log"), "utf8")).not.toContain("release create");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it("does not create a release when GitHub lookup fails", async () => {
  const { directory, run } = await fixture();

  try {
    await expect(run("prepare-release.sh", { LOOKUP_FAIL: "true" })).rejects.toThrow();
    expect(await readFile(join(directory, "gh.log"), "utf8")).not.toContain("release create");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("leaves a partial upload in draft and completes it on a rerun", async () => {
  const { directory, run } = await fixture();

  try {
    await run("prepare-release.sh");
    await expect(
      run("publish-github-release.sh", { FAIL_UPLOAD: "widefleet-images-0.3.0.env" }),
    ).rejects.toThrow();
    expect(JSON.parse(await readFile(join(directory, "metadata.json"), "utf8"))).toMatchObject({
      isDraft: true,
    });
    expect(await readdir(join(directory, "remote"))).toHaveLength(4);
    expect(await readFile(join(directory, "gh.log"), "utf8")).not.toContain("release edit");
    await run("publish-github-release.sh");
    expect(JSON.parse(await readFile(join(directory, "metadata.json"), "utf8"))).toMatchObject({
      isDraft: false,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("recovers after a lost publication response without modifying a published release", async () => {
  const { directory, run } = await fixture();

  try {
    await run("prepare-release.sh");
    await expect(
      run("publish-github-release.sh", { FAIL_AFTER_PUBLISH: "true" }),
    ).rejects.toThrow();
    await writeFile(join(directory, "gh.log"), "");
    await run("publish-github-release.sh");
    const commands = await readFile(join(directory, "gh.log"), "utf8");
    expect(commands).not.toContain("release upload");
    expect(commands).not.toContain("release edit");
    expect(commands.match(/release download/g)).toHaveLength(6);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("keeps the release in draft if transported artifacts have invalid checksums", async () => {
  const { directory, local, run } = await fixture();

  try {
    await run("prepare-release.sh");
    await writeFile(join(local, "widefleet-images-0.3.0.env"), "corrupt");
    await expect(run("publish-github-release.sh")).rejects.toThrow();
    expect(await readdir(join(directory, "remote"))).toEqual([]);
    expect(await readFile(join(directory, "gh.log"), "utf8")).not.toContain("release edit");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
