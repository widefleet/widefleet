import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { DocumentationError, documentServices } from "./index.ts";

// Built by `cargo build --profile wasm -p platform-service-docs-wasm --target wasm32-wasip1`.
const modulePath = new URL(
  "../../../target/wasm32-wasip1/wasm/platform_service_docs_wasm.wasm",
  import.meta.url,
);

// The native test in crates/platform-service-docs/tests/entry.rs uses the same app and output.
const fixture = new URL("../../../crates/platform-service-docs/tests/fixtures/", import.meta.url);

const fixtureFiles = async () => {
  const root = join(fixture.pathname, "app");
  const files = new Map<string, string>();

  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    files.set(`/app/${relative(root, path)}`, await readFile(path, "utf8"));
  }

  files.set("/app/worker.js.map", '{"version":3,"sources":[],"names":[],"mappings":""}');

  return files;
};

describe.runIf(process.env["RUN_WASM_TESTS"] === "1")("service documentation module", () => {
  it("documents the fixture app as the native build does", async () => {
    const module = new WebAssembly.Module(await readFile(modulePath));
    const expected: unknown = JSON.parse(await readFile(new URL("expected.json", fixture), "utf8"));

    const result = documentServices(module, {
      project: "/app",
      bundle: "/app/worker.js",
      map: "/app/worker.js.map",
      entry: "/app/src/app.ts",
      entrypoints: ["default"],
      files: await fixtureFiles(),
    });

    expect(result.documentation).toEqual(expected);
  });

  it("reports the module's error when the source map is missing", async () => {
    const module = new WebAssembly.Module(await readFile(modulePath));
    const files = await fixtureFiles();
    files.delete("/app/worker.js.map");

    expect(() =>
      documentServices(module, {
        project: "/app",
        bundle: "/app/worker.js",
        map: "/app/worker.js.map",
        entry: "/app/src/app.ts",
        entrypoints: ["default"],
        files,
      }),
    ).toThrow(new DocumentationError("Cannot read source map /app/worker.js.map"));
  });
});
