#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { generateServiceDocumentation } from "./index.ts";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    tsconfig: { type: "string", default: "tsconfig.json" },
    out: { type: "string", default: ".widefleet/services.json" },
  },
});

const entry = positionals[0];

if (!entry || positionals.length !== 1)
  throw new Error(
    "Usage: widefleet-service-docs <worker-entry.ts> [--tsconfig tsconfig.json] [--out .widefleet/services.json]",
  );

const result = await generateServiceDocumentation(entry, values.tsconfig);

await mkdir(dirname(values.out), { recursive: true });

await writeFile(values.out, JSON.stringify(result) + "\n");
