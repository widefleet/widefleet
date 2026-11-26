import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const root = fileURLToPath(new URL("../../../templates/", import.meta.url));

const read = (template: string, path: string) => {
  try {
    return readFileSync(join(root, template, path), "utf8");
  } catch {
    return "";
  }
};

const templates = readdirSync(root, { withFileTypes: true }).flatMap((entry) =>
  entry.isDirectory() && read(entry.name, "template.md") ? [entry.name] : [],
);

// The backend origins a template declares; JSONC comments and trailing commas removed.
const declared = (template: string) =>
  z.object({ network: z.object({ backend: z.array(z.string()) }) }).parse(
    JSON.parse(
      read(template, "widefleet.jsonc")
        .replace(/^\s*\/\/.*$/gm, "")
        .replace(/,(\s*[\]}])/g, "$1"),
    ),
  ).network.backend;

describe("templates", () => {
  it.each(templates)("%s allows the origins it calls", (template) => {
    const backend = declared(template);

    // The API address of generated REST templates and the endpoints
    // connections fetch. An address whose host is a variable, such as a
    // Dataverse environment, differs per customer and is allowed by them.
    const called = [
      ...[...read(template, "src/schema.ts").matchAll(/export const base = "([^"]+)"/g)].filter(
        (match) => !match[1]?.includes("{"),
      ),
      ...read(template, "src/connection.ts").matchAll(/fetch\("(https:\/\/[^"]+)"/g),
    ].map((match) => new URL(match[1] ?? "").origin);

    for (const origin of called) expect(backend).toContain(origin);
  });
});
