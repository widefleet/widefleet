import { describe, expect, it } from "vitest";
import { validateConnectorPackage } from "../src/lib/server/connector-package.ts";
import { validateConnectorSecret } from "../src/lib/server/connector-package.ts";
import { connectorFixture } from "./cloudflare-connector.fixture.ts";

describe("Dynamic connector packages", () => {
  it("checks UTF-8 secret limits before publication", () => {
    expect(() => validateConnectorSecret("é".repeat(2500))).not.toThrow();

    for (const value of ["é".repeat(2501), "x".repeat(5001), ""])
      expect(() => validateConnectorSecret(value)).toThrow();
  });
  it("reserves bootstrap modules and accepts facet classes without native migrations", () => {
    const release = connectorFixture();
    release.modules[0] = {
      ...release.modules[0],
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
