import { afterEach, expect, it, vi } from "vitest";
import { signWorkloadRequest, verifyWorkloadRequest } from "./workload-protocol.ts";

const secret = "synthetic-runtime-secret-never-deploy";

const identity = { appId: crypto.randomUUID(), organizationId: "example" };

afterEach(() => vi.useRealTimers());

it("expires runtime assertions and rejects future-issued proofs", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  const proof = await signWorkloadRequest(secret, identity, "data-api");
  expect(await verifyWorkloadRequest(secret, proof)).toMatchObject(identity);
  vi.setSystemTime(new Date("2026-01-01T00:00:30Z"));
  await expect(verifyWorkloadRequest(secret, proof)).rejects.toThrow("Expired");
  vi.setSystemTime(new Date("2025-12-31T23:59:50Z"));
  await expect(verifyWorkloadRequest(secret, proof)).rejects.toThrow("Expired");
});

it("rejects invalid audience input without widening the requested identity", async () => {
  for (const audience of ["", " ", "data\napi", "a".repeat(2049)])
    await expect(signWorkloadRequest(secret, identity, audience)).rejects.toThrow();
});
