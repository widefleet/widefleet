import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execute = promisify(execFile);

const root = new URL("../../../../", import.meta.url);

const components = ["control-plane", "runtime", "agent"];

it.each(components)("preserves repository-wide exclusions for %s", async (component) => {
  const exclusions = await readFile(new URL(".dockerignore", root), "utf8");

  const scoped = await readFile(
    new URL(`infra/${component}/Dockerfile.dockerignore`, root),
    "utf8",
  );

  expect(scoped.endsWith(exclusions)).toBe(true);
});

describe.runIf(process.env["RUN_IMAGE_CONTEXT_TESTS"] === "1")("Docker context isolation", () => {
  it.each(components)(
    "keeps %s cache independent of unrelated source",
    async (component) => {
      const directory = await mkdtemp(join(tmpdir(), "widefleet-image-context-"));
      const context = join(directory, "source");

      const shared = [
        "package.json",
        "pnpm-lock.yaml",
        "pnpm-workspace.yaml",
        "tsconfig.json",
        "tsconfig.base.json",
        ".npmrc",
        ".pnpmfile.cjs",
        ".gitignore",
        ".gitattributes",
        "patches/dependency.patch",
        "packages/app-runtime/src/loader.ts",
        "packages/auth-proxy/src/index.ts",
        "packages/contracts/src/index.ts",
        "apps/control-plane/package.json",
        "apps/docs/package.json",
        "starters/sveltekit/package.json",
        "starters/tanstack-start/package.json",
        "templates/github/package.json",
        "examples/apps/example/package.json",
      ];

      const native = [
        "Cargo.toml",
        "Cargo.lock",
        "rust-toolchain.toml",
        ".cargo/config.toml",
        "crates/platform-core/src/lib.rs",
        "crates/platform-agent/src/main.rs",
        "crates/platform-cli/src/main.rs",
      ];

      const controlPlane = [
        "apps/control-plane/src/routes/+page.svelte",
        "apps/control-plane/tools/prepare-deploy.ts",
        "apps/control-plane/migrations/0001.sql",
      ];

      const excluded = [
        "README.md",
        "docs/architecture.md",
        "apps/docs/blume.config.ts",
        "starters/sveltekit/src/routes/+page.svelte",
        "templates/github/src/index.ts",
        "tools/package-cli.ts",
        ".git/config",
        ".local/secret",
        ".env",
        ".env.production",
        "packages/app-runtime/.env",
        "apps/control-plane/.env.production",
        "node_modules/dependency/index.js",
        "packages/app-runtime/node_modules/dependency/index.js",
        "packages/app-runtime/dist/release.json",
        "apps/control-plane/build/index.js",
        "apps/control-plane/.svelte-kit/output/server/index.js",
        "target/release/widefleet",
        "apps/control-plane/tests/environment.ts",
        "packages/app-runtime/src/module.test.ts",
      ];

      const wanted = [
        "LICENSE",
        ...(component === "agent" ? [] : shared),
        ...(component === "control-plane" ? controlPlane : native),
      ].sort();

      try {
        for (const file of ["LICENSE", ...shared, ...native, ...controlPlane, ...excluded]) {
          await mkdir(dirname(join(context, file)), { recursive: true });
          await writeFile(join(context, file), `Fixture ${directory}: ${file}\n`);
        }

        const dockerfile = join(context, `infra/${component}/Dockerfile`);
        await mkdir(dirname(dockerfile), { recursive: true });
        await writeFile(dockerfile, "FROM scratch\nCOPY . /payload\n");
        await writeFile(
          `${dockerfile}.dockerignore`,
          await readFile(new URL(`infra/${component}/Dockerfile.dockerignore`, root), "utf8"),
        );

        const build = async (name: string) => {
          const destination = join(directory, name);

          const result = await execute(
            "docker",
            [
              "build",
              "--progress=plain",
              "--build-arg",
              `SOURCE_DATE_EPOCH=${name === "first" ? "1700000000" : "1700000001"}`,
              "--label",
              `org.opencontainers.image.revision=${name}`,
              "--file",
              dockerfile,
              "--output",
              `type=local,dest=${destination}`,
              context,
            ],
            { maxBuffer: 4 * 1024 * 1024 },
          );

          const payload = join(destination, "payload");
          const entries = await readdir(payload, { recursive: true, withFileTypes: true });
          expect(
            entries
              .filter((entry) => entry.isFile())
              .map((entry) => join(entry.parentPath, entry.name).slice(payload.length + 1))
              .sort(),
          ).toEqual(wanted);

          return { payload, log: result.stderr };
        };

        await build("first");

        const unrelated =
          component === "control-plane"
            ? "crates/platform-agent/src/main.rs"
            : "apps/control-plane/src/routes/+page.svelte";

        await writeFile(join(context, unrelated), "Unrelated change\n");
        const cached = await build("cached");
        const step = /^(#\d+) .*COPY \. \/payload$/m.exec(cached.log)?.[1];
        expect(step).toBeDefined();
        expect(cached.log).toContain(`${step} CACHED`);

        const relevant = component === "control-plane" ? controlPlane[0] : native[0];

        if (!relevant) throw new Error("Missing build input fixture");
        await writeFile(join(context, relevant), "Relevant change\n");
        const changed = await build("changed");
        expect(await readFile(join(changed.payload, relevant), "utf8")).toBe("Relevant change\n");
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    60_000,
  );
});
