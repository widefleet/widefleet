import { build } from "esbuild";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { z } from "zod";

const license = [
  await readFile(new URL("../../LICENSE", import.meta.url), "utf8"),
  await readFile(new URL("NOTICE", import.meta.url), "utf8"),
].join("\n");

const { version } = z
  .object({ version: z.string() })
  .parse(JSON.parse(await readFile(new URL("package.json", import.meta.url), "utf8")));

const compile = async (entry: string, define: Record<string, string>) => {
  const result = await build({
    entryPoints: [new URL(`src/${entry}.ts`, import.meta.url).pathname],
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2023",
    external: [
      "cloudflare:workers",
      "cloudflare:workflows",
      "./__widefleet_app.js",
      "./__widefleet_workflow.js",
      "node:async_hooks",
    ],
    alias: {
      "widefleet:app": "./__widefleet_app.js",
      "widefleet:workflow": "./__widefleet_workflow.js",
    },
    banner: { js: `/*!\n${license}*/` },
    define,
    write: false,
    legalComments: "eof",
  });

  const output = result.outputFiles[0];

  if (!output) throw new Error("Runtime build produced no module");

  return output.text;
};

const source = await compile("loader", {
  WIDEFLEET_BINDINGS_SOURCE: JSON.stringify(await compile("bindings", {})),
  WIDEFLEET_WORKFLOW_SOURCE: JSON.stringify(await compile("workflow-runner", {})),
  WIDEFLEET_EVENTS_SOURCE: JSON.stringify(await compile("events", {})),
  WIDEFLEET_RUNTIME_VERSION: JSON.stringify(version),
});

const directory = new URL("dist/", import.meta.url);

await mkdir(directory, { recursive: true });

await writeFile(new URL("loader.js", directory), source);

await writeFile(
  new URL("release.json", directory),
  JSON.stringify({
    protocol: 1,
    version,
    celld: "0.6.2",
    workflows: 1,
    main: "loader.js",
    modules: [
      { name: "loader.js", source, sha256: createHash("sha256").update(source).digest("hex") },
    ],
  }),
);
