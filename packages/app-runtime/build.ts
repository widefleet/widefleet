import { build } from "esbuild";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { runtimeVersion } from "@platform/contracts";
import { buildInputForm, buildMcpUi } from "./build-ui.ts";
import { mcpSkillCatalog } from "./src/mcp-skills.ts";

await buildMcpUi();

await buildInputForm();

const license = [
  await readFile(new URL("../../LICENSE", import.meta.url), "utf8"),
  await readFile(new URL("NOTICE", import.meta.url), "utf8"),
].join("\n");

const { version: productVersion } = z
  .object({ version: z.string() })
  .parse(JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")));

// Runtime versions are immutable, so an installation that deploys several builds
// of one product version names each build, for example by its commit.
const buildMetadata = process.env["WIDEFLEET_RUNTIME_BUILD"] || undefined;

const version = runtimeVersion.parse(
  buildMetadata ? `${productVersion}+${buildMetadata}` : productVersion,
);

const extension = process.env["WIDEFLEET_APP_RUNTIME_EXTENSION"];

const directory = new URL("dist/", import.meta.url);

await mkdir(directory, { recursive: true });

if (extension && !isAbsolute(extension))
  throw new Error("WIDEFLEET_APP_RUNTIME_EXTENSION must be an absolute module path");

const compile = async (entry: string, define: Record<string, string>) => {
  const alias = new Map([
    ["widefleet:app", "./__widefleet_app.js"],
    ["widefleet:workflow", "./__widefleet_workflow.js"],
  ]);

  // Runtime extensions belong to the parent, never to embedded child modules.
  if (extension && entry === "loader") alias.set("#runtime-extension", extension);

  const result = await build({
    entryPoints: [new URL(`src/${entry}.ts`, import.meta.url).pathname],
    outfile: new URL(`${entry}.js`, directory).pathname,
    sourcemap: entry === "loader" ? "linked" : false,
    bundle: true,
    format: "esm",
    platform: "neutral",
    // The runtime only runs in Workers runtimes (workerd and celld), so dependencies resolve their workerd builds.
    conditions: ["workerd"],
    mainFields: ["module", "main"],
    target: "es2023",
    external: [
      "cloudflare:workers",
      "cloudflare:workflows",
      "./__widefleet_app.js",
      "./__widefleet_workflow.js",
      "node:*",
    ],
    alias: Object.fromEntries(alias),
    banner: { js: `/*!\n${license}*/` },
    define,
    write: false,
    legalComments: "eof",
  });

  const output = result.outputFiles.find((file) => file.path.endsWith(".js"));
  const sourceMap = result.outputFiles.find((file) => file.path.endsWith(".js.map"));

  if (!output) throw new Error("Runtime build produced no module");

  if (sourceMap) await writeFile(sourceMap.path, sourceMap.contents);

  return output.text;
};

const skill = await readFile(
  new URL("../../plugins/widefleet/skills/widefleet/SKILL.md", import.meta.url),
  "utf8",
);

// Markdown-only changes skip CI, so an invalid skill must fail the build instead of every MCP request.
await mcpSkillCatalog({ widefleet: skill }).read();

const source = await compile("loader", {
  WIDEFLEET_BINDINGS_SOURCE: JSON.stringify(await compile("bindings", {})),
  WIDEFLEET_WORKFLOW_SOURCE: JSON.stringify(await compile("workflow-runner", {})),
  WIDEFLEET_CLOUDFLARE_WORKFLOW_SOURCE: JSON.stringify(
    await compile("workflow-cloudflare-runner", {}),
  ),
  WIDEFLEET_EVENTS_SOURCE: JSON.stringify(await compile("events", {})),
  WIDEFLEET_RUNTIME_VERSION: JSON.stringify(version),
  WIDEFLEET_SKILL_SOURCE: JSON.stringify(skill),
});

await writeFile(new URL("loader.js", directory), source);

await writeFile(
  new URL("release.json", directory),
  JSON.stringify({
    protocol: 3,
    auth: 1,
    version,
    celld: "0.6.3-widefleet.1",
    workflows: 1,
    cloudflare: 1,
    search: 1,
    main: "loader.js",
    modules: [
      { name: "loader.js", source, sha256: createHash("sha256").update(source).digest("hex") },
    ],
  }),
);
