import { expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestEnvironment } from "./environment.ts";
import { seedDeployment } from "./cloudflare-deployment.fixture.ts";
import { memoryStorage } from "./memory-storage.fixture.ts";
import { createArtifactStorage } from "../src/lib/server/artifact-storage.ts";
import { createJobService } from "../src/lib/server/jobs.ts";
import { agents, jobs, organizationRuntimes } from "../src/lib/server/schema.ts";

it.each([443, 25453])("includes the configured HTTPS port %s in native app jobs", async (port) => {
  const environment = await createTestEnvironment();

  try {
    const entry = await seedDeployment(environment.database.db, { bindings: [] });
    const agentId = crypto.randomUUID();
    await environment.database.db.insert(agents).values({
      id: agentId,
      organizationId: entry.organizationId,
      name: "Origin fixture",
      tokenHash: crypto.randomUUID(),
    });
    await environment.database.db
      .update(organizationRuntimes)
      .set({ appliedRuntime: { version: "0.5.0", checksum: "a".repeat(64) } })
      .where(eq(organizationRuntimes.organizationId, entry.organizationId));
    await environment.database.db.insert(jobs).values({
      id: crypto.randomUUID(),
      appId: entry.appId,
      organizationId: entry.organizationId,
      kind: "configure",
    });

    const service = createJobService(
      environment.database.db,
      createArtifactStorage(memoryStorage()),
      environment.environment.PLATFORM_ENCRYPTION_KEY,
      undefined,
      port,
    );

    expect((await service.claim(agentId, true)).unwrap()).toMatchObject({
      appId: entry.appId,
      hostname: entry.hostname,
      origin: `https://${entry.hostname}${port === 443 ? "" : `:${port}`}`,
    });
  } finally {
    await environment.close();
  }
});
