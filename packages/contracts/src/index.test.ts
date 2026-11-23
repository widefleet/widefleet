import { describe, expect, it } from "vitest";
import {
  assetManifest,
  assetPath,
  appSecretValue,
  appSecretPreparation,
  capabilityGrant,
  connectorOf,
  executionWorkerMetadata,
  runtimeVersion,
  workerMetadata,
} from "./index.ts";

describe("runtime versions", () => {
  it.each([
    { value: "0.7.20", accepted: true },
    { value: "0.7.20+5f67a8c3d2e1", accepted: true },
    { value: "0.7.20+build.12", accepted: true },
    { value: "0.7.20-rc.1", accepted: false },
    { value: "0.7.20+", accepted: false },
    { value: "0.7.20+a..b", accepted: false },
    { value: "0.7.20+a/b", accepted: false },
    { value: `0.7.20+${"a".repeat(58)}`, accepted: false },
  ])("$value: $accepted", ({ value, accepted }) => {
    expect(runtimeVersion.safeParse(value).success).toBe(accepted);
  });
});

describe("app secret contracts", () => {
  it.each([
    { label: "empty", value: "", accepted: false },
    { label: "5000 ASCII bytes", value: "x".repeat(5000), accepted: true },
    { label: "5001 ASCII bytes", value: "x".repeat(5001), accepted: false },
    { label: "5000 UTF-8 bytes", value: "é".repeat(2500), accepted: true },
    { label: "5002 UTF-8 bytes", value: "é".repeat(2501), accepted: false },
    { label: "previous 64 KiB limit", value: "x".repeat(65536), accepted: false },
  ])("applies the same limit to input and runtime packages: $label", ({ value, accepted }) => {
    expect(appSecretValue.safeParse(value).success).toBe(accepted);
    expect(appSecretPreparation.shape.values.safeParse({ API_KEY: value }).success).toBe(accepted);
  });
});

describe("worker variables", () => {
  const metadata = { main_module: "worker.js", compatibility_date: "2026-10-01" };

  const parse = (bindings: { type: "plain_text"; name: string; text: string }[]) =>
    workerMetadata.safeParse({
      ...metadata,
      bindings,
      assets: { upload_session: "93d8fffd-d0ed-48cf-8fb7-570219c62a70" },
    }).success;

  it.each([
    { value: "", accepted: true },
    { value: "é".repeat(16384), accepted: true },
    { value: "x".repeat(16385), accepted: false },
  ])("validates variable text length", ({ value, accepted }) => {
    expect(parse([{ type: "plain_text", name: "LABEL", text: value }])).toBe(accepted);
  });
  it.each([
    { count: 32, accepted: true },
    { count: 33, accepted: false },
  ])("validates $count bindings", ({ count, accepted }) => {
    expect(
      parse(
        Array.from({ length: count }, (_, i) => ({
          type: "plain_text",
          name: `VAR_${i}`,
          text: "",
        })),
      ),
    ).toBe(accepted);
  });
});

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

  it.each([
    { connector: undefined, entrypoints: ["Reader"], kind: null },
    // Deployments from before the declaration existed.
    { connector: undefined, entrypoints: ["UserConnection"], kind: "personal" },
    { connector: "personal", entrypoints: ["UserConnection"], kind: "personal" },
    { connector: "shared", entrypoints: ["Reader"], kind: "shared" },
    { connector: "personal", entrypoints: ["Reader"], kind: "rejected" },
    { connector: "shared", entrypoints: ["UserConnection"], kind: "rejected" },
  ])(
    "reads $connector with $entrypoints as connector $kind",
    ({ connector, entrypoints, kind }) => {
      const parsed = workerMetadata.safeParse({
        main_module: "worker.js",
        compatibility_date: "2026-10-01",
        connector,
        entrypoints,
        assets: { upload_session: "93d8fffd-d0ed-48cf-8fb7-570219c62a70" },
      });

      expect(parsed.success ? connectorOf(parsed.data) : "rejected").toBe(kind);

      // Runtimes reject metadata fields they do not know.
      if (parsed.success)
        expect(executionWorkerMetadata(parsed.data)).not.toHaveProperty("connector");
    },
  );

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

it("requires an app target and rejects legacy connector grants", () => {
  expect(capabilityGrant.safeParse({ connector: "mail", entrypoint: "default" }).success).toBe(
    false,
  );
  expect(capabilityGrant.safeParse({ entrypoint: "default" }).success).toBe(false);
  expect(
    capabilityGrant.safeParse({
      app: "93d8fffd-d0ed-48cf-8fb7-570219c62a70",
      entrypoint: "default",
    }).success,
  ).toBe(true);
});
