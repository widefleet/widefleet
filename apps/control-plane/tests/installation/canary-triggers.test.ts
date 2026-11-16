import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";

const workflow = new URL("../../../../.github/workflows/publish-cli.yaml", import.meta.url);

const { on } = z
  .object({
    on: z.object({
      push: z.object({
        branches: z.array(z.string()),
        tags: z.array(z.string()),
        // Literal paths and recursive directory prefixes also cover hidden files.
        paths: z.array(z.string().regex(/^[^*?![\]{}]+(?:\/\*\*)?$/)),
      }),
    }),
  })
  .parse(parse(await readFile(workflow, "utf8")));

const publishes = (files: string[]) =>
  files.some((file) =>
    on.push.paths.some((pattern) =>
      pattern.endsWith("/**") ? file.startsWith(pattern.slice(0, -2)) : file === pattern,
    ),
  );

it.each([
  ["control-plane API", ["apps/control-plane/src/routes/api/apps/+server.ts"]],
  ["control-plane UI", ["apps/control-plane/src/routes/(auth)/(workspace)/apps/+page.svelte"]],
  ["control-plane manifest", ["apps/control-plane/package.json"]],
  ["runtime", ["packages/app-runtime/src/index.ts", "crates/platform-agent/src/main.rs"]],
  ["API contracts", ["packages/contracts/src/index.ts"]],
  ["images", ["infra/runtime/Dockerfile", "tools/build-release-binaries.sh"]],
  ["CLI tests", ["apps/control-plane/tests/cli.test.ts"]],
  ["canary tests", ["apps/control-plane/tests/installation/canary-triggers.test.ts"]],
  ["contributor docs", ["docs/cli-releases.md", "README.md", "AGENTS.md"]],
  ["user docs", ["apps/docs/docs/guides/app-services.md", "apps/docs/docs/reference/cli.mdx"]],
  ["docs site", ["apps/docs/blume.config.ts", "apps/docs/package.json"]],
  ["website", ["apps/website/src/routes/index.tsx"]],
] satisfies [string, string[]][])("does not publish for %s changes", (_name, files) => {
  expect(publishes(files)).toBe(false);
});

it.each([
  "crates/platform-cli/src/main.rs",
  "crates/platform-cli/Cargo.toml",
  "crates/platform-cli/licenses/example.txt",
  "crates/platform-core/src/http.rs",
  "crates/platform-core/Cargo.toml",
  "crates/platform-agent/Cargo.toml",
  "Cargo.toml",
  "Cargo.lock",
  "rust-toolchain.toml",
  ".cargo/config.toml",
  "package.json",
  "tsconfig.json",
  "tsconfig.base.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  ".npmrc",
  ".pnpmfile.cjs",
  "patches/dependency.patch",
  "tools/cargo.sh",
  "tools/package-cli.ts",
  "tools/cli-launcher.ts",
  "tools/cli-platforms.ts",
  "tools/cli-tools.ts",
  "tools/prepare-cli-canary.py",
  "tools/publish-cli.sh",
  "tools/wait-for-npm-package.sh",
  "starters/sveltekit/src/routes/+page.svelte",
  "starters/sveltekit/README.md",
  "starters/sveltekit/AGENTS.md",
  "starters/sveltekit/pnpm-lock.yaml",
  "starters/tanstack-start/src/routes/index.tsx",
  "starters/tanstack-start/README.md",
  "starters/tanstack-start/pnpm-lock.yaml",
  "tools/oxlint/anti-slop/index.ts",
  "tools/oxlint/anti-slop/.config",
  ".gitattributes",
  ".gitignore",
  ".oxlintrc.json",
  ".oxfmtrc.json",
  "LICENSE",
  "apps/docs/docs/getting-started/installation.md",
  ".github/workflows/publish-cli.yaml",
  ".github/workflows/cli-platforms.yaml",
])("publishes for CLI input %s", (file) => {
  expect(publishes([file])).toBe(true);
});

it("publishes when any commit in a mixed push changes a CLI input", () => {
  expect(
    publishes([
      "apps/control-plane/src/routes/api/apps/+server.ts",
      "crates/platform-cli/src/main.rs",
      "docs/cli-releases.md",
    ]),
  ).toBe(true);
  expect(publishes(["apps/control-plane/package.json", "pnpm-lock.yaml"])).toBe(true);
});

it("retains main and stable release tag triggers", () => {
  expect(on.push.branches).toEqual(["main"]);
  // GitHub does not evaluate path filters on tag pushes.
  expect(on.push.tags).toEqual(["v*"]);
});
