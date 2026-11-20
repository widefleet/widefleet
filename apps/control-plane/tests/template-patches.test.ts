import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";

// Templates install standalone, so each carries its own copy of the dependency
// patches it needs. In this repository the root workspace applies the root
// patches, which the copies must match.
const root = new URL("../../../", import.meta.url);

const patches = async (directory: URL) => {
  const workspace = await readFile(new URL("pnpm-workspace.yaml", directory), "utf8");
  const section = /^patchedDependencies:\n((?:[ \t]+.+\n|#.*\n)*)/m.exec(workspace)?.[1] ?? "";

  return new Map(
    [...section.matchAll(/^\s+"?([^"\s:]+)"?:\s*(\S+)\s*$/gm)].flatMap(([, name, path]) =>
      name && path ? [[name, path] as const] : [],
    ),
  );
};

describe("template dependency patches", async () => {
  const declared = await patches(root);

  const templates = (await readdir(new URL("templates/", root), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  it.each(templates)("%s ships the root patches of its dependencies", async (template) => {
    const directory = new URL(`templates/${template}/`, root);

    const manifest = z
      .object({
        dependencies: z.record(z.string(), z.string()).default({}),
      })
      .parse(JSON.parse(await readFile(new URL("package.json", directory), "utf8")));

    const versions = new Map(Object.entries(manifest.dependencies));

    // Root patches for the packages the template's app uses. Development
    // tooling, such as miniflare for local tests, keeps the root patches here.
    const required = [...declared.keys()].filter((key) => {
      const [, name = "", version] = /^(@?[^@]+)(?:@(.+))?$/.exec(key) ?? [];

      return versions.has(name) && (version === undefined || versions.get(name) === version);
    });

    let own = new Map<string, string>();

    if (required.length > 0) own = await patches(directory);
    else
      try {
        own = await patches(directory);
      } catch {
        // A template without patched dependencies needs no pnpm-workspace.yaml.
      }

    for (const key of required) expect(own.has(key), `${template} must declare ${key}`).toBe(true);

    for (const [name, path] of own) {
      const shared = declared.get(name);

      expect(shared, `${name} is not patched in the root workspace`).toBeDefined();
      expect(
        await readFile(fileURLToPath(new URL(path, directory)), "utf8"),
        `${template}/${path} differs from the root patch`,
      ).toBe(await readFile(fileURLToPath(new URL(shared ?? "", root)), "utf8"));
    }
  });
});
