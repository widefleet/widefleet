import { readFile } from "node:fs/promises";
import * as contract from "@platform/contracts";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createAppSecrets } from "../src/lib/server/app-secrets.ts";
import { createArtifactStorage } from "../src/lib/server/artifact-storage.ts";
import { createJobService } from "../src/lib/server/jobs.ts";
import { savePackage } from "../src/lib/server/package-storage.ts";
import { agents, apps, jobs, organizationRuntimes } from "../src/lib/server/schema.ts";
import { seedDeployment } from "./cloudflare-deployment.fixture.ts";
import { createTestEnvironment } from "./environment.ts";
import { memoryStorage } from "./memory-storage.fixture.ts";

let environment: Awaited<ReturnType<typeof createTestEnvironment>>;

beforeAll(async () => {
  environment = await createTestEnvironment();
});

afterAll(async () => environment?.close());

it("reads an app's secrets in its deployment job with the context they were saved with", async () => {
  const database = environment.database.db;
  const storage = createArtifactStorage(memoryStorage());

  const release = contract.runtimeRelease.parse(
    JSON.parse(
      await readFile(new URL(import.meta.resolve("@platform/app-runtime/release")), "utf8"),
    ),
  );

  const checksum = await savePackage(storage, release);
  const entry = await seedDeployment(database, { bindings: [] });
  const agentId = crypto.randomUUID();
  await database.insert(agents).values({
    id: agentId,
    organizationId: entry.organizationId,
    name: "Secret context fixture",
    tokenHash: crypto.randomUUID(),
  });
  await database
    .update(organizationRuntimes)
    .set({ appliedRuntime: { version: release.version, checksum } })
    .where(eq(organizationRuntimes.organizationId, entry.organizationId));

  // The template install path encrypts values before saving them on the app.
  const secrets = await createAppSecrets(database, environment.encryption).encrypt(
    { id: entry.appId, organizationId: entry.organizationId },
    { TOKEN: "synthetic-token" },
  );

  await database.update(apps).set({ secrets, secretRevision: 1 }).where(eq(apps.id, entry.appId));
  await database.insert(jobs).values({
    id: crypto.randomUUID(),
    appId: entry.appId,
    organizationId: entry.organizationId,
    kind: "configure",
  });

  const service = createJobService(database, storage, environment.encryption);
  const claim = (await service.claim(agentId, true)).unwrap();

  if (!claim) throw new Error("The fixture job was not claimed");

  expect((await service.packages(agentId, claim.id, claim.leaseToken)).unwrap().appSecrets).toEqual(
    { appId: entry.appId, revision: 1, values: { TOKEN: "synthetic-token" } },
  );
});
