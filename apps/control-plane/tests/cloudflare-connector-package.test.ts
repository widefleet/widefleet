import { describe, expect, it } from "vitest";
import { validateConnectorPackage } from "../src/lib/server/connector-package.ts";
import { validateConnectorSecret } from "../src/lib/server/connector-package.ts";
import { connectorFixture } from "./cloudflare-connector.fixture.ts";
import { connectorDebugFixture } from "./cloudflare-connector.fixture.ts";
import { createHash } from "node:crypto";

describe("Dynamic connector packages", () => {
  it("validates source maps and their references with the same module rules as apps", () => {
    expect(() => validateConnectorPackage(connectorDebugFixture(), [])).not.toThrow();
    const missing = connectorDebugFixture();
    missing.modules = missing.modules.filter((module) => module.type !== "sourcemap");
    expect(() => validateConnectorPackage(missing, [])).toThrow("does not match");
    const unreferenced = connectorDebugFixture();
    delete unreferenced.debug;
    expect(() => validateConnectorPackage(unreferenced, [])).toThrow("does not match");
    const invalid = connectorDebugFixture();
    invalid.modules = invalid.modules.map((module) =>
      module.type === "sourcemap"
        ? { ...module, source: "{}", sha256: createHash("sha256").update("{}").digest("hex") }
        : module,
    );
    expect(() => validateConnectorPackage(invalid, [])).toThrow("Invalid source-map JSON");
    const main = connectorDebugFixture();
    main.main = "connector.js.map";
    expect(() => validateConnectorPackage(main, [])).toThrow("main ES module");
  });
  it("checks UTF-8 secret limits before publication", () => {
    expect(() => validateConnectorSecret("é".repeat(2500))).not.toThrow();

    for (const value of ["é".repeat(2501), "x".repeat(5001), ""])
      expect(() => validateConnectorSecret(value)).toThrow();
  });
  it("reserves bootstrap modules and accepts facet classes without native migrations", () => {
    const release = connectorFixture();
    release.modules[0] = {
      ...release.modules[0],
      type: "esm",
      source: "",
      sha256: "0".repeat(64),
      name: "__widefleet_connector.js",
    };
    expect(() => validateConnectorPackage(release, [])).toThrow();
    expect(() => validateConnectorPackage(connectorFixture(), [])).not.toThrow();
  });
  it("counts variables and secrets against the connector environment limit", () => {
    const release = connectorFixture();
    expect(() =>
      validateConnectorPackage(
        release,
        Array.from({ length: 127 }, (_, i) => `SECRET_${i}`),
      ),
    ).not.toThrow();
    expect(() =>
      validateConnectorPackage(
        release,
        Array.from({ length: 128 }, (_, i) => `SECRET_${i}`),
      ),
    ).toThrow("128");
  });
});
