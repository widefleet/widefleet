import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generateServiceDocumentation } from "../src/index.ts";

describe("service documentation", () => {
  it("extracts public methods, types and comments without exposing Worker handlers or implementation paths", async () => {
    const root = fileURLToPath(new URL("./fixtures/", import.meta.url));
    const generated = await generateServiceDocumentation("app.ts", "tsconfig.json", root);
    const service = generated.documentation["default"];
    expect(service?.description).toBe("A normal app publishing a search API.");
    expect(service?.methods.map((method) => method.name)).toEqual(["search"]);
    expect(service?.methods[0]).toMatchObject({
      description: "Find matching records.",
      parameters: [
        { name: "input", type: "Search", description: "Search text and optional page size." },
      ],
    });
    expect(service?.methods[0]?.examples[0]).toContain(
      'await env.READER.search({ query: "invoice" });',
    );
    expect(service?.types["Search"]).toContain("query: string");
    expect(generated.inputs["app.ts"]).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(generated.documentation)).not.toContain(root);
    expect(JSON.stringify(generated.documentation)).not.toContain("node_modules");
  });
});
