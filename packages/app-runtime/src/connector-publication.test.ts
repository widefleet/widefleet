import { describe, expect, it } from "vitest";
import { decryptConnectorSecrets, encryptConnectorSecrets } from "./connector-publication.ts";

const identity = {
  organizationId: crypto.randomUUID(),
  name: "fixture",
  version: crypto.randomUUID(),
};

describe("Connector snapshot encryption", () => {
  it("keeps secrets readable when the control token changes", async () => {
    const first = {
      WIDEFLEET_CONNECTOR_KEY: "ab".repeat(32),
      WIDEFLEET_CONTROL_TOKEN: "original-control-token",
    };

    const encrypted = await encryptConnectorSecrets(first, identity, { TOKEN: "synthetic-secret" });
    expect(encrypted).not.toContain("synthetic-secret");
    const rotated = { ...first, WIDEFLEET_CONTROL_TOKEN: "rotated-control-token" };
    expect(await decryptConnectorSecrets(rotated, identity, encrypted)).toEqual({
      TOKEN: "synthetic-secret",
    });
    await expect(
      decryptConnectorSecrets({ WIDEFLEET_CONNECTOR_KEY: "cd".repeat(32) }, identity, encrypted),
    ).rejects.toThrow();
    await expect(
      decryptConnectorSecrets(first, { ...identity, version: crypto.randomUUID() }, encrypted),
    ).rejects.toThrow();
  });
});
