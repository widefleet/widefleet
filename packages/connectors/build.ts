import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { networkPolicy } from "@platform/contracts";
import { z } from "zod";
import ts from "typescript";

const applications = [
  {
    slug: "github",
    displayName: "GitHub",
    backend: ["https://github.com", "https://api.github.com"],
  },
  {
    slug: "gmail",
    displayName: "Gmail",
    backend: [
      "https://accounts.google.com",
      "https://oauth2.googleapis.com",
      "https://www.googleapis.com",
      "https://gmail.googleapis.com",
    ],
  },
  {
    slug: "onedrive",
    displayName: "OneDrive",
    backend: ["https://login.microsoftonline.com", "https://graph.microsoft.com"],
  },
];

const configuration = z.object({
  main: z.string(),
  compatibility_date: z.string(),
  compatibility_flags: z.array(z.string()),
  d1_databases: z.array(z.object({ binding: z.string(), database_name: z.string() })),
});

const bundle = [];

for (const app of applications) {
  const configPath = fileURLToPath(import.meta.resolve(`@widefleet/${app.slug}/wrangler.jsonc`));
  const directory = dirname(configPath);
  const parsed = ts.parseConfigFileTextToJson(configPath, await readFile(configPath, "utf8"));

  if (parsed.error)
    throw new Error(ts.flattenDiagnosticMessageText(parsed.error.messageText, "\n"));
  const config = configuration.parse(parsed.config);

  const result = await build({
    absWorkingDir: directory,
    entryPoints: [config.main],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    external: ["cloudflare:*", "node:*"],
    minify: true,
  });

  const source = z.string().parse(result.outputFiles[0]?.text);

  bundle.push({
    slug: app.slug,
    displayName: app.displayName,
    source,
    network: networkPolicy.parse({ backend: app.backend, browser: [] }),
    metadata: {
      main_module: "worker.js",
      compatibility_date: config.compatibility_date,
      compatibility_flags: config.compatibility_flags,
      web: true,
      entrypoints: ["default"],
      bindings: config.d1_databases.map((database) => ({
        type: "d1",
        name: database.binding,
        database_name: database.database_name,
      })),
    },
  });
}

await mkdir(new URL("./dist/", import.meta.url), { recursive: true });

await writeFile(new URL("./dist/apps.json", import.meta.url), JSON.stringify(bundle) + "\n");
