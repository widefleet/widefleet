import { describe, expect, it } from "vitest";
import {
  validateConnectorPackage,
  uploadedConnector,
} from "../src/lib/server/connector-package.ts";
import { validateConnectorSecret } from "../src/lib/server/connector-package.ts";
import {
  connectorFixture,
  connectorFiles,
  connectorModule,
} from "./cloudflare-connector.fixture.ts";
import { connectorDebugFixture } from "./cloudflare-connector.fixture.ts";

const validate = (release: ReturnType<typeof connectorFixture>) =>
  uploadedConnector(release.name, release.metadata, connectorFiles(release)).unwrap();

describe("Dynamic connector packages", () => {
  it("validates source maps and their references with the same module rules as apps", () => {
    expect(() => validate(connectorDebugFixture())).not.toThrow();
    const missing = connectorDebugFixture();
    missing.modules = missing.modules.filter((module) => module.type !== "sourcemap");
    expect(() => validate(missing)).toThrow("does not match");
    const unreferenced = connectorDebugFixture();
    delete unreferenced.metadata.debug;
    expect(() => validate(unreferenced)).toThrow("does not match");
    const invalid = connectorDebugFixture();
    invalid.modules = invalid.modules.map((module) =>
      module.type === "sourcemap" ? connectorModule(module.name, module.type, "{}") : module,
    );
    expect(() => validate(invalid)).toThrow("Invalid source-map JSON");
    const main = connectorDebugFixture();
    main.metadata.main_module = "connector.js.map";
    expect(() => validate(main)).toThrow("main ES module");
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
      size: 0,
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
