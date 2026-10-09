import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execute = promisify(execFile);

const root = fileURLToPath(new URL("../../../../", import.meta.url));

const digest = `docker.io/widefleet/widefleet-agent@sha256:${"a".repeat(64)}`;

const revision = "b".repeat(40);

const version = "0.0.1";

const fixture = async () => {
  const directory = await mkdtemp(join(tmpdir(), "widefleet-release-recovery-"));
  await Promise.all(
    Object.entries({
      curl: `#!/bin/bash
set -euo pipefail
while [[ "$1" != --output ]]; do shift; done
output=$2
if [[ "\${!#}" == */tags/* ]]; then
  cp "$RUNNER_TEMP/tag.json" "$output"
  printf '%s' "$TAG_STATUS"
else
  cp "$RUNNER_TEMP/package.json" "$output"
  printf '%s' "$HTTP_STATUS"
fi
`,
      docker: `#!/bin/bash
set -euo pipefail
printf '%s\\n' "$*" >> "$RUNNER_TEMP/docker.log"
case "$1" in
  pull|load) ;;
  image)
    if [[ "$*" == *--format* ]]; then
      echo sha256:tested
    else
      cat "$RUNNER_TEMP/image.json"
    fi
    ;;
  *) exit 1 ;;
esac
`,
    }).map(([name, source]) => writeFile(join(directory, name), source, { mode: 0o755 })),
  );

  const metadata = {
    name: "widefleet-agent",
    namespace: "widefleet",
    is_private: false,
  };

  const image = {
    Os: "linux",
    Architecture: "amd64",
    RepoDigests: [digest],
    Config: {
      Labels: {
        "org.opencontainers.image.source": "https://github.com/widefleet/widefleet",
        "org.opencontainers.image.revision": revision,
        "org.opencontainers.image.version": version,
      },
    },
  };

  await Promise.all([
    writeFile(join(directory, "package.json"), JSON.stringify(metadata)),
    writeFile(join(directory, "tag.json"), JSON.stringify({ name: version })),
    writeFile(join(directory, "image.json"), JSON.stringify([image])),
  ]);

  const run = (script = "recover-release-image", environment = {}) =>
    execute("bash", [`tools/${script}.sh`, "agent"], {
      cwd: root,
      env: {
        PATH: `${directory}:${process.env["PATH"] ?? "/usr/bin:/bin"}`,
        RUNNER_TEMP: directory,
        RELEASE_IMAGES: directory,
        VERSION: version,
        REVISION: revision,
        REQUIRE_EXISTING: "false",
        HTTP_STATUS: "200",
        TAG_STATUS: "200",
        ...environment,
      },
    });

  return { directory, metadata, image, run };
};

it("recovers matching images and retains their registry digest across image transport", async () => {
  const { directory, run } = await fixture();

  try {
    await run();
    expect(await readFile(join(directory, "agent.existing"), "utf8")).toBe("1\n");
    expect(await readFile(join(directory, "agent.digest"), "utf8")).toBe(`${digest}\n`);
    expect(await readFile(join(directory, "docker.log"), "utf8")).toContain(
      `pull --platform linux/amd64 docker.io/widefleet/widefleet-agent:${version}`,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("allows missing images only before publication and fails on registry errors", async () => {
  const { directory, run } = await fixture();

  try {
    await run("recover-release-image", { HTTP_STATUS: "404" });
    expect(await readFile(join(directory, "agent.existing"), "utf8")).toBe("0\n");
    await expect(
      run("recover-release-image", { HTTP_STATUS: "404", REQUIRE_EXISTING: "true" }),
    ).rejects.toThrow("refusing to rebuild");
    await expect(run("recover-release-image", { HTTP_STATUS: "500" })).rejects.toThrow();
    await expect(
      run("recover-release-image", { TAG_STATUS: "404", REQUIRE_EXISTING: "true" }),
    ).rejects.toThrow("refusing to rebuild");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it.each([{ is_private: true }, { namespace: "example" }, { name: "other" }])(
  "rejects an unsafe package destination: %j",
  async (override) => {
    const { directory, metadata, run } = await fixture();

    try {
      await writeFile(
        join(directory, "package.json"),
        JSON.stringify({ ...metadata, ...override }),
      );
      await expect(run()).rejects.toThrow();
      await expect(readFile(join(directory, "docker.log"))).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it("rejects an existing image from another source commit", async () => {
  const { directory, image, run } = await fixture();

  try {
    image.Config.Labels["org.opencontainers.image.revision"] = "c".repeat(40);
    await writeFile(join(directory, "image.json"), JSON.stringify([image]));
    await expect(run()).rejects.toThrow();
    await expect(readFile(join(directory, "agent.digest"))).rejects.toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("verifies transported image IDs and rejects a mismatched artifact", async () => {
  const { directory, run } = await fixture();

  try {
    for (const component of ["runtime", "agent", "control-plane", "sso"]) {
      await writeFile(join(directory, `${component}.id`), "sha256:tested\n");
    }

    await run("load-release-images");
    await writeFile(join(directory, "agent.id"), "sha256:other\n");
    await expect(run("load-release-images")).rejects.toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
