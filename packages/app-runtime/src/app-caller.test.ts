import { afterEach, describe, expect, it, vi } from "vitest";
import { signAppCaller, verifyAppCaller } from "./app-caller.ts";

const secret = "synthetic-app-caller-key-not-for-deployment";

const appId = "00000000-0000-4000-8000-000000000001";

const nextId = "00000000-0000-4000-8000-000000000002";

const caller = { issuer: "https://identity.example.test", subject: "alice", name: "Alice" };

describe("App caller delegation", () => {
  afterEach(() => vi.useRealTimers());

  it("binds the principal to an app and organization and rejects modified proofs", async () => {
    const proof = await signAppCaller(secret, appId, "example", caller);
    expect((await verifyAppCaller(secret, appId, "example", proof)).caller).toEqual(caller);
    await expect(verifyAppCaller(secret, nextId, "example", proof)).rejects.toThrow();
    await expect(verifyAppCaller(secret, appId, "other", proof)).rejects.toThrow();
    await expect(verifyAppCaller(`${secret}-other`, appId, "example", proof)).rejects.toThrow();
    const [payload, signature] = proof.split(".");

    const changed = btoa(
      atob((payload ?? "").replaceAll("-", "+").replaceAll("_", "/")).replace("alice", "bob"),
    )
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, "");

    await expect(
      verifyAppCaller(secret, appId, "example", `${changed}.${signature}`),
    ).rejects.toThrow();
    await expect(verifyAppCaller(secret, appId, "example", `${proof}.extra`)).rejects.toThrow();
  });

  it("keeps the original expiry across service hops", async () => {
    vi.useFakeTimers();
    const proof = await signAppCaller(secret, appId, "example", caller);
    vi.setSystemTime(Date.now() + 299_000);
    const verified = await verifyAppCaller(secret, appId, "example", proof);

    const next = await signAppCaller(
      secret,
      nextId,
      "example",
      verified.caller,
      verified.expiresAt,
    );

    expect((await verifyAppCaller(secret, nextId, "example", next)).caller).toEqual(caller);
    vi.setSystemTime(Date.now() + 1_000);
    await expect(verifyAppCaller(secret, appId, "example", proof)).rejects.toThrow();
    await expect(verifyAppCaller(secret, nextId, "example", next)).rejects.toThrow();
  });
});
