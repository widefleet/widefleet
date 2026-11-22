import { describe, expect, it } from "vitest";
import {
  encodeDocumentation,
  readDocumentation,
  storeDocumentation,
} from "../src/lib/server/artifact-documentation.ts";
import { createArtifactStorage } from "../src/lib/server/artifact-storage.ts";
import { memoryStorage } from "./memory-storage.fixture.ts";

const documentation = (summary: string) =>
  encodeDocumentation({
    format: 1,
    entrypoints: [
      { name: "Reader", summary, remarks: "", examples: [], http: false, methods: [] },
      { name: "default", summary: "", remarks: "", examples: [], http: true, methods: [] },
    ],
    types: [],
  });

// Like every supported object store, keep the first object written under a key.
const immutableStorage = () => {
  const store = memoryStorage();

  return createArtifactStorage({
    ...store,
    put: async (key, bytes) => {
      if (!(await store.exists(key))) await store.put(key, bytes);
    },
  });
};

describe("Artifact documentation storage", () => {
  const appId = crypto.randomUUID();

  it("summarizes which entrypoints document anything", () => {
    expect(documentation("Reads records.").summary.entrypoints).toEqual([
      { name: "Reader", documented: true },
      { name: "default", documented: false },
    ]);
  });

  it("accepts a retried publish only with the documentation it first wrote", async () => {
    const storage = immutableStorage();
    const artifactId = crypto.randomUUID();
    const first = documentation("First attempt.");

    (await storeDocumentation(storage, appId, artifactId, first)).unwrap();
    (await storeDocumentation(storage, appId, artifactId, first)).unwrap();

    for (const retry of [documentation("Second attempt."), null])
      expect(await storeDocumentation(storage, appId, artifactId, retry)).toMatchObject({
        error: { code: "CONFLICT" },
      });

    expect((await readDocumentation(storage, appId, artifactId)).unwrap()).toMatchObject({
      entrypoints: [{ summary: "First attempt." }, { name: "default" }],
    });
  });

  it("publishes without documentation when none was written for the session", async () => {
    const storage = immutableStorage();

    (await storeDocumentation(storage, appId, crypto.randomUUID(), null)).unwrap();
  });
});
