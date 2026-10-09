import * as contract from "@platform/contracts";
import { Result } from "better-result";
import { sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createRuntimeReleaseService,
  ensureFleetRuntime,
} from "../../src/lib/server/runtime-releases.ts";
import { fleets, jobs, runtimeReleases } from "../../src/lib/server/schema.ts";
import { transact } from "../../src/lib/server/transactions.ts";
import { createTestEnvironment } from "../environment.ts";
import { createStorageTestEnvironment } from "./environment.ts";

describe("Runtime installation with PostgreSQL and Azure Blob Storage", () => {
  let environment: Awaited<ReturnType<typeof createTestEnvironment>>;
  let fixture: Awaited<ReturnType<typeof createStorageTestEnvironment>>;
  let releases: ReturnType<typeof createRuntimeReleaseService>;

  const source = "export default {};";

  const release = contract.runtimeRelease.parse({
    protocol: 1,
    version: "99.0.0",
    celld: "0.6.2",
    main: "loader.js",
    modules: [
      { name: "loader.js", source, sha256: createHash("sha256").update(source).digest("hex") },
    ],
  });

  const bytes = Buffer.from(JSON.stringify(release));
  const checksum = createHash("sha256").update(bytes).digest("hex");
  const key = `packages/sha256/${checksum}.json`;

  const principal = () => ({
    ...environment.owner,
    role: "owner" as const,
    admin: true,
    creator: true,
  });

  const bundledRelease = async () =>
    contract.runtimeRelease.parse(
      JSON.parse(
        await readFile(new URL(import.meta.resolve("@platform/app-runtime/release")), "utf8"),
      ),
    );

  beforeAll(async () => {
    environment = await createTestEnvironment();
  });

  beforeEach(async () => {
    await environment.database.db.delete(jobs);
    await environment.database.db
      .update(fleets)
      .set({ runtime: null, appliedRuntime: null, runtimeJobId: null });
    await environment.database.db.delete(runtimeReleases);
    fixture = await createStorageTestEnvironment("azure");
    releases = createRuntimeReleaseService(environment.database.db, fixture.storage);
  });

  afterEach(async () => {
    await fixture?.close();
    expect(fixture?.failures).toEqual([]);
  });

  afterAll(async () => {
    await environment?.close();
  });

  it("installs only the requested release on an empty fleet", async () => {
    expect((await releases.install(principal(), release)).unwrap()).toMatchObject({
      desiredVersion: release.version,
      activeVersion: null,
      state: "queued",
      versions: [release.version],
    });
    expect([...fixture.objects.keys()]).toEqual([key]);
    expect(fixture.objects.get(key)).toEqual(bytes);
    expect(fixture.requests.map(({ method }) => method)).toEqual(["PUT"]);
    expect(await environment.database.db.select().from(runtimeReleases)).toMatchObject([
      { version: release.version, checksum },
    ]);
    expect(await environment.database.db.select().from(jobs)).toMatchObject([
      { kind: "runtime", runtime: { version: release.version, checksum }, state: "queued" },
    ]);
  });

  it("accepts repeated and concurrent installs without replacing immutable package bytes", async () => {
    (await releases.install(principal(), release)).unwrap();

    const results = await Promise.all([
      releases.install(principal(), release),
      releases.install(principal(), release),
    ]);

    for (const result of results) expect(result.unwrap().desiredVersion).toBe(release.version);
    expect([...fixture.objects.keys()]).toEqual([key]);
    expect(fixture.objects.get(key)).toEqual(bytes);
    expect(await environment.database.db.select().from(runtimeReleases)).toHaveLength(1);

    const queued = await environment.database.db.select().from(jobs);
    const [fleet] = await environment.database.db.select().from(fleets);

    expect(queued).toHaveLength(3);

    for (const job of queued) expect(job.runtime).toEqual({ version: release.version, checksum });
    expect(queued.some((job) => job.id === fleet?.runtimeJobId)).toBe(true);
    expect(fleet?.runtime).toEqual({ version: release.version, checksum });
  });

  it("installs the bundled version explicitly with a single upload on an empty fleet", async () => {
    const bundled = await bundledRelease();
    const submitted = (await releases.install(principal(), bundled)).unwrap();

    expect(submitted).toMatchObject({
      desiredVersion: bundled.version,
      versions: [bundled.version],
      state: "queued",
    });
    expect(fixture.objects.size).toBe(1);
    expect(fixture.requests.map(({ method }) => method)).toEqual(["PUT"]);
    expect(await environment.database.db.select().from(jobs)).toHaveLength(1);
  });

  it("reuses an uploaded package after the database transaction rolls back", async () => {
    await environment.database.db.execute(
      sql`ALTER TABLE job ADD CONSTRAINT reject_runtime_fixture CHECK (kind <> 'runtime')`,
    );

    try {
      const failed = await releases.install(principal(), release);

      expect(failed.isErr()).toBe(true);
      expect(failed.isErr() && failed.error).toMatchObject({ _tag: "DatabaseUnavailable" });
      expect([...fixture.objects.keys()]).toEqual([key]);
      expect(fixture.objects.get(key)).toEqual(bytes);
      expect(await environment.database.db.select().from(runtimeReleases)).toHaveLength(0);
      expect(await environment.database.db.select().from(jobs)).toHaveLength(0);
      expect(await environment.database.db.select().from(fleets)).toMatchObject([
        { runtime: null, runtimeJobId: null },
      ]);
    } finally {
      await environment.database.db.execute(
        sql`ALTER TABLE job DROP CONSTRAINT reject_runtime_fixture`,
      );
    }

    expect((await releases.install(principal(), release)).unwrap().state).toBe("queued");
    expect([...fixture.objects.keys()]).toEqual([key]);
    expect(fixture.objects.get(key)).toEqual(bytes);
    expect(await environment.database.db.select().from(runtimeReleases)).toHaveLength(1);
    expect(await environment.database.db.select().from(jobs)).toHaveLength(1);
  });

  it("does not commit a release or job when artifact storage rejects the upload", async () => {
    fixture.failUpload(409, "ContainerBeingDeleted");
    const failed = await releases.install(principal(), release);

    expect(failed.isErr()).toBe(true);
    expect(failed.isErr() && failed.error).toMatchObject({ _tag: "StorageUnavailable" });
    expect(fixture.objects.size).toBe(0);
    expect(await environment.database.db.select().from(runtimeReleases)).toHaveLength(0);
    expect(await environment.database.db.select().from(jobs)).toHaveLength(0);
    expect(await environment.database.db.select().from(fleets)).toMatchObject([
      { runtime: null, runtimeJobId: null },
    ]);
  });

  it("rejects different valid bytes for an installed version", async () => {
    (await releases.install(principal(), release)).unwrap();
    const changed = "export default { changed: true };";

    const failed = await releases.install(principal(), {
      ...release,
      modules: [
        {
          name: release.main,
          source: changed,
          sha256: createHash("sha256").update(changed).digest("hex"),
        },
      ],
    });

    expect(failed.isErr()).toBe(true);
    expect(failed.isErr() && failed.error).toMatchObject({ code: "CONFLICT" });
    expect([...fixture.objects.keys()]).toEqual([key]);
    expect(fixture.objects.get(key)).toEqual(bytes);
    expect(await environment.database.db.select().from(runtimeReleases)).toMatchObject([
      { version: release.version, checksum },
    ]);
    expect(await environment.database.db.select().from(jobs)).toHaveLength(1);
  });

  it("does not install the bundled release as a side effect of rolling back an empty fleet", async () => {
    const bundled = await bundledRelease();
    const failed = await releases.rollback(principal(), { version: bundled.version });

    expect(failed.isErr()).toBe(true);
    expect(failed.isErr() && failed.error).toMatchObject({ code: "NOT_FOUND" });
    expect(fixture.requests).toHaveLength(0);
    expect(await environment.database.db.select().from(runtimeReleases)).toHaveLength(0);
    expect(await environment.database.db.select().from(jobs)).toHaveLength(0);
  });

  it("still bootstraps the bundled runtime for app jobs and reuses it during explicit installation", async () => {
    const [fleet] = await environment.database.db.select().from(fleets);

    if (!fleet) throw new Error("Missing default fleet");

    const initialized = await transact(environment.database.db, async (transaction) =>
      Result.ok(await ensureFleetRuntime(transaction, fixture.storage, fleet.id)),
    );

    const bundled = await bundledRelease();

    expect(initialized.unwrap().version).toBe(bundled.version);
    expect((await releases.install(principal(), bundled)).unwrap()).toMatchObject({
      desiredVersion: bundled.version,
      versions: [bundled.version],
      state: "queued",
    });
    expect(fixture.objects.size).toBe(1);
  });
});
