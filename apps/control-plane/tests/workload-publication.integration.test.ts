import { afterAll, beforeAll, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { workloadConfiguration } from "@platform/app-runtime/workload";
import { createTestEnvironment } from "./environment.ts";
import { publishWorkloadAdmission } from "../src/lib/server/workload-publication.ts";
import { organizationRuntimes } from "../src/lib/server/schema.ts";

let environment: Awaited<ReturnType<typeof createTestEnvironment>>;

beforeAll(async () => {
  environment = await createTestEnvironment();
});

afterAll(async () => {
  await environment.close();
});

it("publishes current extension admission and database suspension without exposing the database to workloads", async () => {
  let enabled = true;
  let published: string | undefined;

  const extension = {
    organizationAccess: {
      filterOrganizations: async (candidates: readonly { id: string }[]) =>
        enabled ? candidates.map(({ id }) => id) : [],
    },
  };

  const sync = () =>
    publishWorkloadAdmission(
      environment.database.db,
      environment.configuration,
      extension,
      async (body) => {
        published = body;
      },
    );

  const current = () => workloadConfiguration.parse(JSON.parse(published!));
  await sync();
  expect(current()).toEqual({
    issuer: "https://auth.apps.localhost/workload",
    organizations: ["widefleet"],
  });
  enabled = false;
  await sync();
  expect(current().organizations).toEqual([]);
  enabled = true;
  await environment.database.db
    .update(organizationRuntimes)
    .set({ httpBlocked: true })
    .where(eq(organizationRuntimes.organizationId, "widefleet"));
  await sync();
  expect(current().organizations).toEqual([]);
  await environment.database.db
    .update(organizationRuntimes)
    .set({ httpBlocked: false })
    .where(eq(organizationRuntimes.organizationId, "widefleet"));
  await sync();
  expect(current().organizations).toEqual(["widefleet"]);
});

it("keeps the last published configuration on failure and recovers on the next reconciliation", async () => {
  let published = "";

  const receive = async (body: string) => {
    published = body;
  };

  await publishWorkloadAdmission(environment.database.db, environment.configuration, {}, receive);
  const initial = published;
  const extension = { organizationAccess: { filterOrganizations: async () => [] } };
  await expect(
    publishWorkloadAdmission(
      environment.database.db,
      environment.configuration,
      extension,
      async () => {
        throw new Error("Runtime unavailable");
      },
    ),
  ).rejects.toThrow("Runtime unavailable");
  expect(published).toBe(initial);
  await publishWorkloadAdmission(
    environment.database.db,
    environment.configuration,
    extension,
    receive,
  );
  expect(workloadConfiguration.parse(JSON.parse(published)).organizations).toEqual([]);
});
