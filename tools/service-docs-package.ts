import { build } from "esbuild";
import { cp, mkdir, readdir, copyFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export async function packageServiceDocumentation(directory: string) {
  const target = join(directory, "service-docs");
  await mkdir(target, { recursive: true });
  // Keep TypeScript beside its declaration libraries. Its compiler locates them
  // relative to typescript.js, independently of the app's installed TS version.
  const compiler = dirname(fileURLToPath(import.meta.resolve("typescript")));
  await cp(join(compiler, "typescript.js"), join(target, "typescript.js"));

  for (const file of await readdir(compiler))
    if (file.startsWith("lib.") && file.endsWith(".d.ts"))
      await copyFile(join(compiler, file), join(target, file));

  const bundled = await build({
    entryPoints: [fileURLToPath(new URL("./service-docs-cli.ts", import.meta.url))],
    outfile: join(target, "extract.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22.18",
    alias: { typescript: "./typescript.js" },
    external: ["./typescript.js"],
    metafile: true,
  });

  const dependencies = new Set([dirname(compiler)]);

  for (const input of Object.keys(bundled.metafile.inputs)) {
    if (!input.includes("node_modules")) continue;
    let directory = dirname(resolve(input));

    while (directory !== dirname(directory)) {
      const files = await readdir(directory);

      if (files.includes("package.json")) {
        dependencies.add(directory);
        break;
      }

      directory = dirname(directory);
    }
  }

  await mkdir(join(target, "licenses"), { recursive: true });

  for (const dependency of dependencies)
    for (const file of await readdir(dependency))
      if (/^(license|copyright|notice|thirdpartynotice)/i.test(file))
        await copyFile(
          join(dependency, file),
          join(target, "licenses", `${basename(dependency)}-${file}`),
        );
}
