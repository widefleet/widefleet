import { afterEach, describe, expect, it } from "vitest";
import {
  artifactStorageSchema,
  azureStorageSchema,
  gcsStorageSchema,
} from "../../src/lib/server/storage/config.ts";
import { createStorageTestEnvironment } from "./environment.ts";

const azure = azureStorageSchema.parse({
  ARTIFACT_STORAGE_PROVIDER: "azure",
  AZURE_STORAGE_ACCOUNT_NAME: "testaccount",
  AZURE_STORAGE_CONTAINER: "artifacts",
  AZURE_STORAGE_ACCESS_KEY: "dGVzdC1rZXk=",
});

const gcs = gcsStorageSchema.parse({ ARTIFACT_STORAGE_PROVIDER: "gcs", GCS_BUCKET: "artifacts" });

describe.each(["azure", "gcs"] as const)(
  "%s artifact storage over its native HTTP protocol",
  (provider) => {
    let fixture: Awaited<ReturnType<typeof createStorageTestEnvironment>>;

    const setup = async () => {
      fixture = await createStorageTestEnvironment(provider);

      return fixture.storage;
    };

    afterEach(async () => {
      if (fixture) {
        await fixture.close();
        expect(fixture.failures).toEqual([]);
      }
    });

    it("uploads exact binary bytes and keeps the first content at an existing key", async () => {
      const storage = await setup();
      const key = "apps/example/modules/worker.js";
      const bytes = new Uint8Array([0, 1, 127, 128, 255]);

      expect((await storage.put(key, bytes, "application/javascript")).isOk()).toBe(true);
      expect((await storage.put(key, new Uint8Array([42]), "application/javascript")).isOk()).toBe(
        true,
      );
      expect((await storage.get(key)).unwrap()).toEqual(bytes);
      expect((await storage.exists(key)).unwrap()).toBe(true);
      expect((await storage.exists("apps/example/missing")).unwrap()).toBe(false);
      expect(
        fixture.requests
          .filter((request) => ["PUT", "POST"].includes(request.method))
          .every((request) => request.conditional),
      ).toBe(true);
    });

    it("lists every page and removes only the selected app, including modules", async () => {
      const storage = await setup();

      for (const name of ["one", "two", "three", "four", "five"])
        fixture.objects.set(`apps/example/assets/${name}`, Buffer.from(name));
      fixture.objects.set("apps/example/modules/worker.js", Buffer.from("worker"));
      fixture.objects.set("apps/example-other/assets/keep", Buffer.from("keep"));
      const inventory = (await storage.assetInventory("example")).unwrap();

      expect(inventory.size).toBe(5);
      expect(inventory.get("three")).toBe(5);
      expect(fixture.listingPages()).toBeGreaterThan(1);
      expect((await storage.removeApp("example")).isOk()).toBe(true);
      expect([...fixture.objects.keys()]).toEqual(["apps/example-other/assets/keep"]);
      expect((await storage.removeApp("example")).isOk()).toBe(true);
    });

    it("accepts concurrent uploads while preserving the first stored bytes", async () => {
      const storage = await setup();
      const key = "packages/sha256/concurrent.json";
      const bytes = Buffer.from("runtime package");

      const results = await Promise.all(
        Array.from({ length: 4 }, () => storage.put(key, bytes, "application/json")),
      );

      expect(results.every((result) => result.isOk())).toBe(true);
      expect(fixture.objects.size).toBe(1);
      expect((await storage.get(key)).unwrap()).toEqual(new Uint8Array(bytes));
    });

    it.runIf(provider === "azure")(
      "also accepts ConditionNotMet for an existing blob",
      async () => {
        const storage = await setup();
        const key = "packages/sha256/precondition.json";
        const bytes = Buffer.from("original package");

        fixture.duplicateStatus(412);
        fixture.objects.set(key, bytes);
        expect(
          (await storage.put(key, Buffer.from("replacement"), "application/json")).isOk(),
        ).toBe(true);
        expect((await storage.get(key)).unwrap()).toEqual(new Uint8Array(bytes));
      },
    );

    it.runIf(provider === "azure").each([
      [409, "ContainerBeingDeleted"],
      [409, "BlobImmutableDueToPolicy"],
      [412, "LeaseIdMissing"],
      [412, "LeaseIdMismatchWithBlobOperation"],
      [409, "ConditionNotMet"],
      [412, "BlobAlreadyExists"],
    ])("propagates Azure %i %s instead of reporting a successful upload", async (status, code) => {
      const storage = await setup();

      fixture.failUpload(status, code);

      const result = await storage.put(
        "packages/sha256/failed.json",
        Buffer.from("package"),
        "application/json",
      );

      expect(result.isErr()).toBe(true);
      expect(result.isErr() && result.error.cause).toMatchObject({ statusCode: status, code });
      expect(fixture.objects.size).toBe(0);
    });

    it("reports access failures instead of treating them as absent or already uploaded", async () => {
      const storage = await setup();

      fixture.deny(true);
      expect((await storage.exists("apps/example/missing")).isErr()).toBe(true);
      expect((await storage.get("apps/example/missing")).isErr()).toBe(true);
      expect(
        (await storage.put("apps/example/new", new Uint8Array([1]), "text/plain")).isErr(),
      ).toBe(true);
      expect((await storage.assetInventory("example")).isErr()).toBe(true);
    });

    it("surfaces partial teardown failures so the job can retry", async () => {
      const storage = await setup();

      fixture.objects.set("apps/example/assets/one", Buffer.from("one"));
      fixture.failDeletion(true);
      expect((await storage.removeApp("example")).isErr()).toBe(true);
      expect(fixture.objects.size).toBe(1);
      fixture.failDeletion(false);
      expect((await storage.removeApp("example")).isOk()).toBe(true);
    });
  },
);

describe("storage configuration", () => {
  it("retains S3 as the default for existing installations", () => {
    const parsed = artifactStorageSchema.parse({
      S3_ENDPOINT: "http://localhost:9000",
      S3_BUCKET: "artifacts",
      S3_ACCESS_KEY_ID: "test",
      S3_SECRET_ACCESS_KEY: "test-secret",
    });

    expect(parsed.ARTIFACT_STORAGE_PROVIDER).toBe("s3");
    expect(artifactStorageSchema.safeParse({}).success).toBe(false);
    expect(artifactStorageSchema.safeParse({ ARTIFACT_STORAGE_PROVIDER: "typo" }).success).toBe(
      false,
    );
  });

  it("accepts cloud settings without any S3 variables", () => {
    expect(artifactStorageSchema.parse(azure)).toEqual(azure);
    expect(artifactStorageSchema.parse(gcs)).toEqual(gcs);
  });

  it("rejects conflicting or incomplete Azure credentials and invalid storage names", () => {
    expect(
      artifactStorageSchema.safeParse({
        ...azure,
        AZURE_CLIENT_ID: "00000000-0000-4000-8000-000000000001",
      }).success,
    ).toBe(false);
    expect(
      artifactStorageSchema.safeParse({
        ...azure,
        AZURE_STORAGE_ACCESS_KEY: undefined,
        AZURE_FEDERATED_TOKEN_FILE: "/run/identity/token",
      }).success,
    ).toBe(false);
    expect(
      artifactStorageSchema.safeParse({ ...azure, AZURE_STORAGE_CONTAINER: "not/a/container" })
        .success,
    ).toBe(false);
    expect(
      artifactStorageSchema.safeParse({ ...gcs, GOOGLE_APPLICATION_CREDENTIALS: "relative.json" })
        .success,
    ).toBe(false);
  });
});
