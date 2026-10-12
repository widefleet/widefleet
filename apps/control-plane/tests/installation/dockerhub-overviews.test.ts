import { execFile } from "node:child_process";
import { copyFile, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execute = promisify(execFile);

const root = fileURLToPath(new URL("../../../../", import.meta.url));

const components = ["runtime", "agent", "control-plane", "sso"];

const fixture = async () => {
  const directory = await mkdtemp(join(tmpdir(), "widefleet-dockerhub-overviews-"));
  await mkdir(join(directory, "tools"));
  await mkdir(join(directory, "temporary"));
  await mkdir(join(directory, "remote"));
  await cp(join(root, ".github/dockerhub"), join(directory, ".github/dockerhub"), {
    recursive: true,
  });
  await copyFile(
    join(root, "tools/sync-dockerhub-overviews.sh"),
    join(directory, "tools/sync-dockerhub-overviews.sh"),
  );
  await writeFile(
    join(directory, "auth.json"),
    JSON.stringify({ access_token: "synthetic-bearer-token" }),
  );
  await writeFile(
    join(directory, "releases.json"),
    JSON.stringify([{ tag_name: "v0.3.2", draft: false, prerelease: false }]),
  );
  await writeFile(
    join(directory, "gh"),
    `#!/bin/bash
set -euo pipefail
test "$*" = 'api --paginate repos/widefleet/widefleet/releases?per_page=100'
cat "$FIXTURE/releases.json"
# A later page can fail after earlier pages have been returned.
test "\${FAIL_RELEASE_LOOKUP:-false}" != true
`,
    { mode: 0o755 },
  );
  await writeFile(
    join(directory, "curl"),
    `#!/bin/bash
set -euo pipefail
url=\${!#}
printf '%s\\n' "$url" >> "$FIXTURE/requests.log"
if [[ "$url" == https://hub.docker.com/v2/auth/token ]]; then
  jq -e '. == {identifier: "synthetic-user", secret: "synthetic-access-token"}' > /dev/null
  test "\${FAIL_AUTH:-false}" != true
  cat "$FIXTURE/auth.json"
  exit
fi
method=''
header=''
payload=''
while [[ $# -gt 0 ]]; do
  case "$1" in
    --request) method=$2; shift ;;
    --header) header=\${2#@}; shift ;;
    --json) payload=\${2#@}; shift ;;
  esac
  shift
done
test "$method" = PATCH
test "$(cat "$header")" = 'Authorization: Bearer synthetic-bearer-token'
case "$url" in
  https://hub.docker.com/v2/repositories/widefleet/runtime|\
https://hub.docker.com/v2/repositories/widefleet/agent|\
https://hub.docker.com/v2/repositories/widefleet/control-plane|\
https://hub.docker.com/v2/repositories/widefleet/sso) ;;
  *) exit 1 ;;
esac
component=\${url##*/}
test "$component" != "\${FAIL_COMPONENT:-}"
cp "$payload" "$FIXTURE/remote/$component.json"
`,
    { mode: 0o755 },
  );

  const run = (environment = {}) =>
    execute("bash", [join(directory, "tools/sync-dockerhub-overviews.sh")], {
      cwd: directory,
      env: {
        PATH: `${directory}:${process.env["PATH"] ?? "/usr/bin:/bin"}`,
        TMPDIR: join(directory, "temporary"),
        FIXTURE: directory,
        GITHUB_REPOSITORY: "widefleet/widefleet",
        RELEASE_TAG: "v0.3.2",
        DOCKERHUB_USERNAME: "synthetic-user",
        DOCKERHUB_TOKEN: "synthetic-access-token",
        ...environment,
      },
    });

  return { directory, run };
};

it("syncs all four overviews verbatim without exposing credentials", async () => {
  const { directory, run } = await fixture();

  try {
    await writeFile(
      join(directory, ".github/dockerhub/sso.md"),
      '# SSO\n\n"Quoted" text, backslash \\ and Unicode →\n',
    );
    const result = await run();

    for (const component of components) {
      expect(
        JSON.parse(await readFile(join(directory, "remote", `${component}.json`), "utf8")),
      ).toEqual({
        full_description: await readFile(
          join(directory, ".github/dockerhub", `${component}.md`),
          "utf8",
        ),
      });
      expect(result.stdout).toContain(`Updated Docker Hub overview: widefleet/${component}`);
    }

    expect(`${result.stdout}${result.stderr}`).not.toContain("synthetic-");
    expect(await readdir(join(directory, "temporary"))).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it.each(["missing", "empty"])(
  "rejects a %s overview before contacting Docker Hub",
  async (state) => {
    const { directory, run } = await fixture();

    try {
      const overview = join(directory, ".github/dockerhub/sso.md");

      if (state === "missing") await rm(overview);
      else await writeFile(overview, "");

      await expect(run()).rejects.toThrow();
      await expect(readFile(join(directory, "requests.log"))).rejects.toThrow();
      expect(await readdir(join(directory, "temporary"))).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it.each([{}, { access_token: "" }, { access_token: null }])(
  "does not update repositories without a valid bearer token: %j",
  async (response) => {
    const { directory, run } = await fixture();

    try {
      await writeFile(join(directory, "auth.json"), JSON.stringify(response));
      await expect(run()).rejects.toThrow();
      expect(await readFile(join(directory, "requests.log"), "utf8")).toBe(
        "https://hub.docker.com/v2/auth/token\n",
      );
      expect(await readdir(join(directory, "remote"))).toEqual([]);
      expect(await readdir(join(directory, "temporary"))).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it("stops on authentication failure", async () => {
  const { directory, run } = await fixture();

  try {
    await expect(run({ FAIL_AUTH: "true" })).rejects.toThrow();
    expect(await readdir(join(directory, "remote"))).toEqual([]);
    expect(await readdir(join(directory, "temporary"))).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("reports a failed update and can safely retry a partial sync", async () => {
  const { directory, run } = await fixture();

  try {
    await expect(run({ FAIL_COMPONENT: "control-plane" })).rejects.toThrow();
    expect(await readdir(join(directory, "remote"))).toEqual(["agent.json", "runtime.json"]);
    expect(await readdir(join(directory, "temporary"))).toEqual([]);
    await run();
    expect(await readdir(join(directory, "remote"))).toEqual(
      components.map((component) => `${component}.json`).sort(),
    );
    expect(await readdir(join(directory, "temporary"))).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("skips an older retry without overwriting newer overviews", async () => {
  const { directory, run } = await fixture();

  try {
    await run();
    await rm(join(directory, "requests.log"));
    await writeFile(join(directory, ".github/dockerhub/sso.md"), "Outdated description");
    const published = await readFile(join(directory, "remote/sso.json"), "utf8");
    const result = await run({ RELEASE_TAG: "v0.3.1" });

    expect(result.stdout).toContain("Skipping Docker Hub overviews for v0.3.1");
    expect(await readFile(join(directory, "remote/sso.json"), "utf8")).toBe(published);
    await expect(readFile(join(directory, "requests.log"))).rejects.toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("compares stable platform versions numerically across release pages", async () => {
  const { directory, run } = await fixture();

  try {
    await writeFile(
      join(directory, "releases.json"),
      [
        [
          { tag_name: "v0.3.2", draft: false, prerelease: false },
          { tag_name: "runtime-v99.0.0", draft: false, prerelease: false },
          { tag_name: "v0.3.9", draft: false, prerelease: false },
        ],
        [
          { tag_name: "v99.0.0", draft: true, prerelease: false },
          { tag_name: "v98.0.0", draft: false, prerelease: true },
          { tag_name: "v97.0.0-beta.1", draft: false, prerelease: false },
          { tag_name: "v0.3.10", draft: false, prerelease: false },
        ],
      ]
        .map((page) => JSON.stringify(page))
        .join("\n"),
    );
    expect((await run()).stdout).toContain("latest published version is v0.3.10");
    await expect(readFile(join(directory, "requests.log"))).rejects.toThrow();
    await run({ RELEASE_TAG: "v0.3.10" });
    expect(await readdir(join(directory, "remote"))).toHaveLength(4);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("does not contact Docker Hub when the release lookup fails", async () => {
  const { directory, run } = await fixture();

  try {
    await expect(run({ FAIL_RELEASE_LOOKUP: "true" })).rejects.toThrow();
    await expect(readFile(join(directory, "requests.log"))).rejects.toThrow();
    expect(await readdir(join(directory, "remote"))).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("rejects an empty list of published platform releases", async () => {
  const { directory, run } = await fixture();

  try {
    await writeFile(join(directory, "releases.json"), "[]");
    await expect(run()).rejects.toThrow("No published stable platform release found");
    await expect(readFile(join(directory, "requests.log"))).rejects.toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
