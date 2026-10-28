import { afterEach, describe, expect, it, vi } from "vitest";
import { signConnectorCaller, verifyConnectorCaller } from "./connector-caller.ts";

const secret = "synthetic-caller-signing-key-never-deploy";

const appId = "11111111-1111-4111-8111-111111111111";

const caller = {
  issuer: "https://identity.example.test",
  subject: "alice",
  name: "Alice",
};

describe("Connector caller boundary", () => {
  afterEach(() => vi.useRealTimers());

  it("binds a verified principal to the originating app and organization", async () => {
    const proof = await signConnectorCaller(secret, appId, "example", caller);
    expect(await verifyConnectorCaller(secret, appId, "example", proof)).toEqual(caller);
    await expect(
      verifyConnectorCaller(secret, crypto.randomUUID(), "example", proof),
    ).rejects.toThrow();
    await expect(verifyConnectorCaller(secret, appId, "another-org", proof)).rejects.toThrow();
    await expect(
      verifyConnectorCaller(secret + "changed", appId, "example", proof),
    ).rejects.toThrow();
    const fields = proof.split(".");
    fields[0] = btoa(
      JSON.stringify({
        purpose: "widefleet-connector-caller/v1",
        appId,
        organizationId: "example",
        caller: { ...caller, subject: "bob" },
        expiresAt: Date.now() + 300_000,
      }),
    );
    await expect(
      verifyConnectorCaller(secret, appId, "example", fields.join(".")),
    ).rejects.toThrow();
  });

  it("expires assertions carried beyond their request window", async () => {
    const proof = await signConnectorCaller(secret, appId, "example", caller);
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 300_001);
    await expect(verifyConnectorCaller(secret, appId, "example", proof)).rejects.toThrow();
  });
});
