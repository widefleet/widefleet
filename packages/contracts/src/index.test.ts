import { describe, expect, it } from "vitest";
import { assetManifest, assetPath, workerMetadata } from "./index.ts";

describe("deployment contracts", () => {
  it.each([
    { flags: [], accepted: true },
    { flags: ["nodejs_als"], accepted: true },
    { flags: ["nodejs_compat"], accepted: true },
    { flags: ["nodejs_als", "nodejs_compat"], accepted: true },
    { flags: ["nodejs_compat", "nodejs_compat"], accepted: false },
    { flags: ["unsupported_flag"], accepted: false },
  ])("validates compatibility flags $flags", ({ flags, accepted }) => {
    expect(
      workerMetadata.safeParse({
        main_module: "worker.js",
        compatibility_date: "2026-10-01",
        compatibility_flags: flags,
        assets: { upload_session: "93d8fffd-d0ed-48cf-8fb7-570219c62a70" },
      }).success,
    ).toBe(accepted);
  });

  it.each(["/../secret", "/a/../secret", "/a//file", "/a\\file", "/a\u0000file", "relative"])(
    "rejects unsafe asset path %s",
    (path) => {
      expect(assetPath.safeParse(path).success).toBe(false);
    },
  );

  it("rejects conflicting lengths for a content hash", () => {
    const hash = "a".repeat(32);

    expect(
      assetManifest.safeParse({
        "/one.txt": { hash, size: 1 },
        "/two.txt": { hash, size: 2 },
      }).success,
    ).toBe(false);
  });

  it("rejects resource bindings that shadow the assets binding", () => {
    expect(
      workerMetadata.safeParse({
        main_module: "worker.js",
        compatibility_date: "2026-10-01",
        bindings: [{ type: "d1", name: "ASSETS", database_name: "notes" }],
        assets: { upload_session: "93d8fffd-d0ed-48cf-8fb7-570219c62a70" },
      }).success,
    ).toBe(false);
  });

  it("rejects undeclared binding types", () => {
    expect(
      workerMetadata.safeParse({
        main_module: "worker.js",
        compatibility_date: "2026-10-01",
        bindings: [{ type: "service", name: "OTHER_APP", service: "another-app" }],
        assets: { upload_session: "93d8fffd-d0ed-48cf-8fb7-570219c62a70" },
      }).success,
    ).toBe(false);
  });
});
