import * as contract from "@platform/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestEnvironment } from "./environment.ts";
import { connectorDebugFixture, connectorFiles } from "./cloudflare-connector.fixture.ts";
import { seedDeployment } from "./cloudflare-deployment.fixture.ts";
import { createArtifactStorage } from "../src/lib/server/artifact-storage.ts";
import {
  connectorReference,
  loadConnector,
  loadConnectorArtifact,
  saveConnector,
} from "../src/lib/server/connector-package.ts";
import { cloudflareOperations, jobs } from "../src/lib/server/schema.ts";
import { createSymbolicator } from "../src/lib/server/source-maps.ts";

describe("Private connector debug artifacts", () => {
  let environment: Awaited<ReturnType<typeof createTestEnvironment>>;
  let fleetId: string;
  const objects = new Map<string, Uint8Array>();
  const reads: string[] = [];

  const storage = createArtifactStorage({
    put: async (key, bytes) => {
      objects.set(key, bytes);
    },
    get: async (key) => {
      reads.push(key);
      const bytes = objects.get(key);

      if (!bytes) throw new Error("Missing fixture object");

      return bytes;
    },
    exists: async (key) => objects.has(key),
    list: async function* (prefix) {
      for (const [key, bytes] of objects)
        if (key.startsWith(prefix)) yield { key, size: bytes.byteLength };
    },
    remove: async (keys) => {
      for (const key of keys) objects.delete(key);
    },
  });

  beforeAll(async () => {
    environment = await createTestEnvironment();
    fleetId = (await seedDeployment(environment.database.db)).fleetId;
  });
  afterAll(async () => {
    await environment.close();
  });

  it.each(["connector", "runtime", "cloudflare"] as const)(
    "resolves historical %s versions without downloading code or using the current release",
    async (kind) => {
      const release = connectorDebugFixture(`debug-${kind}`);
      const checksum = await saveConnector(storage, fleetId, release, connectorFiles(release));

      const reference = connectorReference.parse({
        name: release.name,
        checksum,
        entrypoints: release.metadata.entrypoints,
        classes: ["Counter"],
      });

      const version = crypto.randomUUID();

      if (kind === "cloudflare") {
        await environment.database.db.insert(cloudflareOperations).values({
          id: version,
          fleetId,
          command: {},
          targets: [],
          result: reference,
          createdAt: new Date(),
        });
      } else {
        await environment.database.db.insert(jobs).values({
          id: version,
          fleetId,
          kind,
          connector: kind === "connector" ? reference : null,
          connectors: kind === "runtime" ? [reference] : [],
        });
      }

      const artifact = await loadConnectorArtifact(storage, reference);
      expect(JSON.stringify(artifact)).not.toContain("sourcesContent");
      expect(artifact.release.modules.every((module) => !("source" in module))).toBe(true);
      expect(await loadConnector(storage, reference)).toEqual(release);
      const keys = [...objects.keys()].sort();
      expect(await saveConnector(storage, fleetId, release, connectorFiles(release))).toBe(
        checksum,
      );
      expect([...objects.keys()].sort()).toEqual(keys);

      reads.length = 0;
      const target = { fleetId, name: release.name };
      const resolve = createSymbolicator(environment.database.db, storage, target);

      const log = contract.runtimeLog.parse({
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        receivedAt: "1",
        level: "error",
        source: "server",
        kind: "error",
        message: "fixture error",
        stack: "Error: fixture error\n    at inspect (connector.js:1:1)",
        buildId: "untrusted-other-build",
        deploymentId: null,
        connectorVersion: version,
        requestId: null,
        traceId: null,
        spanId: null,
        route: null,
        status: null,
        body: "",
        frames: [],
      });

      expect((await resolve(log)).frames).toEqual([
        expect.objectContaining({ file: "src/connector.ts", line: 1, column: 1, name: "inspect" }),
      ]);
      expect((await resolve(log)).frames).toHaveLength(1);
      expect(reads).toHaveLength(2);
      expect(reads.some((key) => key.endsWith(release.modules[0]?.sha256 ?? "missing"))).toBe(
        false,
      );

      for (const other of [
        { ...target, name: "another-connector" },
        { ...target, fleetId: crypto.randomUUID() },
      ]) {
        const wrong = await createSymbolicator(environment.database.db, storage, other)(log);
        expect(wrong.frames[0]?.file).toBeNull();
      }

      const map = release.modules.find((module) => module.type === "sourcemap");

      if (!map) throw new Error("Missing fixture map");
      const key = `connectors/${fleetId}/${release.name}/modules/${map.sha256}`;

      for (const bytes of [Buffer.from("invalid JSON"), null]) {
        if (bytes) objects.set(key, bytes);
        else objects.delete(key);
        const unresolved = await createSymbolicator(environment.database.db, storage, target)(log);
        expect(unresolved.message).toBe(log.message);
        expect(unresolved.frames[0]).toMatchObject({
          file: null,
          generatedLine: 1,
          generatedColumn: 1,
        });
      }
    },
  );
});
