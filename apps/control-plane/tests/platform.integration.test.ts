import { createWorkflowService } from "../src/lib/server/workflows.ts";
import { createMigrationService } from "../src/lib/server/migrations.ts";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRuntimeReleaseService } from "../src/lib/server/runtime-releases.ts";
import { createDirectory } from "../src/lib/server/directory.ts";
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import * as contract from "@platform/contracts";
import { Result } from "better-result";
import { eq, sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createAgentService } from "../src/lib/server/agents.ts";
import { createApi } from "../src/lib/server/api.ts";
import { apiResource } from "../src/lib/server/auth-options.ts";
import { createConnectorService } from "../src/lib/server/connectors.ts";
import { createAppAccessService } from "../src/lib/server/app-access.ts";
import { createNetworkService } from "../src/lib/server/network.ts";
import { createAppService } from "../src/lib/server/apps.ts";
import { hashAsset } from "../src/lib/server/asset-hash.ts";
import { createIdentityService } from "../src/lib/server/identity.ts";
import { createJobService } from "../src/lib/server/jobs.ts";
import {
  agents,
  apps,
  artifacts,
  deployments,
  fleets,
  jobs,
  runtimeReleases,
  connectors,
  installationSecrets,
} from "../src/lib/server/schema.ts";
import { InvalidOperation, StorageUnavailable } from "../src/lib/server/errors.ts";
import { transact } from "../src/lib/server/transactions.ts";
import { createStorage } from "../src/lib/server/storage.ts";
import { createUploadService } from "../src/lib/server/uploads.ts";
import { createTestEnvironment } from "./environment.ts";
import { createTelemetry } from "../src/lib/server/telemetry.ts";

describe("Platform API with PostgreSQL and RustFS", () => {
  let environment: Awaited<ReturnType<typeof createTestEnvironment>>;
  let api: ReturnType<typeof createApi>;
  let storage: ReturnType<typeof createStorage>;
  let s3: S3Client;
  let adminHeaders: Headers;
  let outsiderHeaders: Headers;
  let outsiderId: string;
  let agentId: string;
  let fleetId: string;
  let agentHeaders: Headers;
  const directoryRequests: URL[] = [];
  const reportedOperations: z.infer<typeof contract.reportingOperation>[] = [];
  let directoryStatus = 200;

  beforeAll(async () => {
    environment = await createTestEnvironment();
    environment.configuration.S3_BUCKET = `test-${crypto.randomUUID()}`;
    const configuration = environment.configuration;
    s3 = new S3Client({
      endpoint: configuration.S3_ENDPOINT,
      region: configuration.S3_REGION,
      forcePathStyle: true,
      credentials: {
        accessKeyId: configuration.S3_ACCESS_KEY_ID,
        secretAccessKey: configuration.S3_SECRET_ACCESS_KEY,
      },
    });
    await s3.send(new CreateBucketCommand({ Bucket: configuration.S3_BUCKET }));
    storage = createStorage(configuration);
    api = createApi({
      directory: createDirectory(
        {
          ...configuration,
          IDENTITY: { ...configuration.IDENTITY, directory: configuration.IDENTITY.management },
        },
        async (input, init) => {
          const request = new Request(input, init);

          if (request.url.endsWith("/token"))
            return Response.json({ access_token: "directory-test-token", expires_in: 3600 });
          directoryRequests.push(new URL(request.url));

          if (directoryStatus !== 200)
            return new Response("sensitive upstream error", { status: directoryStatus });

          return Response.json({
            value: [
              {
                id: "00000000-0000-4000-8000-000000000011",
                displayName: "Einkauf International",
                description: "Procurement",
              },
            ],
          });
        },
      ),
      ...environment,
      storage,
      identity: createIdentityService(environment.auth, environment.database.db, configuration),
      apps: createAppService(environment.database.db, configuration),
      network: createNetworkService(environment.database.db),
      appAccess: createAppAccessService(environment.database.db),
      workflows: createWorkflowService(environment.database.db),
      migrations: createMigrationService(environment.database.db, storage),
      connectors: createConnectorService(
        environment.database.db,
        storage,
        "local-integration-test-encryption-key-only",
      ),
      agents: createAgentService(environment.database.db),
      jobs: createJobService(
        environment.database.db,
        storage,
        "local-integration-test-encryption-key-only",
        (event) => {
          reportedOperations.push(event);
        },
      ),
      releases: createRuntimeReleaseService(environment.database.db, storage),
      uploads: createUploadService(environment.database.db, storage, configuration),
      telemetry: createTelemetry(environment.database.db, storage, configuration),
    });
    const admin = environment.users.createUser({ email: "admin@example.test" });
    const outsider = environment.users.createUser({ email: "outsider@example.test" });
    outsiderId = outsider.id;
    await environment.users.saveUser(admin);
    await environment.users.saveUser(outsider);
    await environment.linkMicrosoftUser(admin.id, z.uuid().parse(environment.ownerSubject));
    await environment.linkMicrosoftUser(outsider.id, crypto.randomUUID());
    adminHeaders = new Headers((await environment.users.login({ userId: admin.id })).headers);
    outsiderHeaders = new Headers((await environment.users.login({ userId: outsider.id })).headers);
    const response = await json("/agents", "POST", { name: "Local test agent" });
    expect(response.status).toBe(200);

    const created = z
      .object({ agent: contract.agent, token: z.string() })
      .parse(await response.json());

    agentId = created.agent.id;
    const [fleet] = await environment.database.db.select().from(fleets);

    if (!fleet) throw new Error("Missing default fleet");
    fleetId = fleet.id;
    agentHeaders = new Headers({ authorization: `Bearer ${created.token}` });
  });

  afterAll(async () => {
    if (s3) {
      const page = await s3.send(
        new ListObjectsV2Command({ Bucket: environment.configuration.S3_BUCKET }),
      );

      const objects = (page.Contents ?? []).flatMap((entry) =>
        entry.Key ? [{ Key: entry.Key }] : [],
      );

      if (objects.length)
        await s3.send(
          new DeleteObjectsCommand({
            Bucket: environment.configuration.S3_BUCKET,
            Delete: { Objects: objects },
          }),
        );
      await s3.send(new DeleteBucketCommand({ Bucket: environment.configuration.S3_BUCKET }));
      s3.destroy();
    }

    await environment?.close();
  });

  const json = <T>(
    path: string,
    method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH",
    body?: T,
    credentials = adminHeaders,
    key?: string,
  ) => {
    const headers = new Headers(credentials);
    headers.set("origin", environment.configuration.PLATFORM_URL);
    headers.set("content-type", "application/json");

    if (key) headers.set("idempotency-key", key);

    const options: RequestInit = { method, headers };

    if (body !== undefined) {
      if (method === "GET") throw new Error("GET requests cannot have a body");
      options.body = JSON.stringify(body);
    }

    return api(new Request(`${environment.configuration.PLATFORM_URL}/api/v1${path}`, options));
  };

  const createApp = async (slug: string) => {
    const response = await json("/apps", "POST", {
      slug,
      displayName: slug,
      parentId: null,
    });

    expect(response.status).toBe(200);

    return contract.app.parse(await response.json());
  };

  it("authorizes reporting settings and rejects arbitrary diagnostic fields", async () => {
    expect((await json("/reporting", "GET", undefined, outsiderHeaders)).status).toBe(403);
    expect(
      (await json("/reporting", "PUT", { usage: false, crashes: false }, outsiderHeaders)).status,
    ).toBe(403);
    const status = contract.reportingStatus.parse(await (await json("/reporting", "GET")).json());
    expect(status.effective).toEqual({ usage: false, crashes: false });
    expect(
      (
        await json("/reporting/errors", "POST", {
          version: "0.2.0",
          error: { type: "Error", frames: [], message: "secret" },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await json("/reporting/errors", "POST", {
          version: "0.2.0",
          error: { type: "Error", frames: [] },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await json(
          "/agent/reporting",
          "POST",
          { version: "0.2.0", os: "linux", arch: "x86_64" },
          agentHeaders,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await json(
          "/agent/reporting",
          "POST",
          { version: "customer-name", os: "linux", arch: "x86_64" },
          agentHeaders,
        )
      ).status,
    ).toBe(400);
  });

  it("installs and rolls back runtime releases on an empty fleet through replaceable executors", async () => {
    const release = contract.runtimeRelease.parse(
      JSON.parse(
        await readFile(new URL(import.meta.resolve("@platform/app-runtime/release")), "utf8"),
      ),
    );

    expect(await (await json("/runtime", "GET")).json()).toMatchObject({
      activeVersion: null,
      desiredVersion: null,
    });
    expect((await json("/runtime", "PUT", release, outsiderHeaders)).status).toBe(403);
    const submitted = await json("/runtime", "PUT", release);
    expect(submitted.status).toBe(200);
    expect(contract.runtimeStatus.parse(await submitted.json())).toMatchObject({
      state: "queued",
      desiredVersion: release.version,
      activeVersion: null,
    });

    const claim = contract.job.parse(
      await (await json("/agent/jobs/claim", "POST", {}, agentHeaders)).json(),
    );

    expect(claim).toMatchObject({
      fleetId,
      appId: null,
      kind: "runtime",
      hostname: null,
      artifactId: null,
    });

    const packages = contract.runtimePackages.parse(
      await (
        await json(
          `/agent/jobs/${claim.id}/packages?leaseToken=${claim.leaseToken}`,
          "GET",
          undefined,
          agentHeaders,
        )
      ).json(),
    );

    expect(packages.runtime).toEqual(release);
    expect(await environment.database.db.select().from(apps)).toHaveLength(0);
    const storedReleases = await environment.database.db.select().from(runtimeReleases);
    expect(storedReleases).toHaveLength(1);
    expect(storedReleases[0]?.version).toBe(release.version);
    expect(storedReleases[0]?.checksum).toMatch(/^[a-f0-9]{64}$/);
    await environment.database.db
      .update(jobs)
      .set({ leaseUntil: new Date(0) })
      .where(eq(jobs.id, claim.id));

    const replacement = z
      .object({ agent: contract.agent, token: z.string() })
      .parse(await (await json("/agents", "POST", { name: "Runtime replacement" })).json());

    const credentials = new Headers({ authorization: `Bearer ${replacement.token}` });

    const retry = contract.job.parse(
      await (await json("/agent/jobs/claim", "POST", {}, credentials)).json(),
    );

    expect(retry.id).toBe(claim.id);
    expect(retry.fleetId).toBe(claim.fleetId);
    expect(
      (
        await json(
          `/agent/jobs/${claim.id}/complete`,
          "POST",
          { leaseToken: claim.leaseToken, outcome: "succeeded", message: "Stale" },
          agentHeaders,
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await json(
          `/agent/jobs/${retry.id}/complete`,
          "POST",
          { leaseToken: retry.leaseToken, outcome: "succeeded", message: "Activated" },
          credentials,
        )
      ).status,
    ).toBe(200);
    await json(`/agents/${replacement.agent.id}`, "DELETE");
    const next = { ...release, version: "0.1.1" };
    expect((await json("/runtime", "PUT", next)).status).toBe(200);

    const failed = contract.job.parse(
      await (await json("/agent/jobs/claim", "POST", {}, agentHeaders)).json(),
    );

    expect(
      (
        await json(
          `/agent/jobs/${failed.id}/complete`,
          "POST",
          { leaseToken: failed.leaseToken, outcome: "failed", message: "Readiness failed" },
          agentHeaders,
        )
      ).status,
    ).toBe(200);
    expect(await (await json("/runtime", "GET")).json()).toMatchObject({
      desiredVersion: next.version,
      activeVersion: release.version,
      state: "failed",
      message: "Readiness failed",
    });
    expect((await json("/runtime/rollback", "POST", { version: release.version })).status).toBe(
      200,
    );

    const rollback = contract.job.parse(
      await (await json("/agent/jobs/claim", "POST", {}, agentHeaders)).json(),
    );

    expect(
      (
        await json(
          `/agent/jobs/${rollback.id}/complete`,
          "POST",
          { leaseToken: rollback.leaseToken, outcome: "succeeded", message: "Rolled back" },
          agentHeaders,
        )
      ).status,
    ).toBe(200);
    expect(await (await json("/runtime", "GET")).json()).toMatchObject({
      activeVersion: release.version,
      desiredVersion: release.version,
      state: "succeeded",
    });
    expect(
      (
        await json("/runtime", "PUT", {
          ...release,
          modules: release.modules.map((module) => ({
            ...module,
            source: module.source + "changed",
          })),
        })
      ).status,
    ).toBe(400);
    expect((await json("/runtime/rollback", "POST", { version: "99.0.0" })).status).toBe(404);
  });

  it("authenticates group search and validates query parameters through the API", async () => {
    const path = "/groups?query=Einkauf%20International&limit=2";
    expect((await json(path, "GET", undefined, new Headers())).status).toBe(401);
    expect(directoryRequests).toHaveLength(0);

    const response = await json(path, "GET", undefined, outsiderHeaders);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      groups: [
        {
          id: "00000000-0000-4000-8000-000000000011",
          name: "Einkauf International",
          description: "Procurement",
          source: "Microsoft",
        },
      ],
      hasMore: false,
    });
    expect(directoryRequests).toHaveLength(1);
    expect(directoryRequests[0]?.searchParams.get("$search")).toBe(
      '"displayName:Einkauf International"',
    );
    expect(directoryRequests[0]?.searchParams.get("$top")).toBe("3");
    expect((await json("/groups?query=Einkauf&limit=0", "GET")).status).toBe(400);
    expect(directoryRequests).toHaveLength(1);
  });

  it("maps unavailable directory access to HTTP 503 without exposing upstream errors", async () => {
    directoryStatus = 403;

    try {
      const response = await json("/groups?query=Einkauf", "GET", undefined, outsiderHeaders);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        code: "SERVICE_UNAVAILABLE",
        message:
          "Directory access has not been granted. Ask an administrator to approve the group read permission.",
      });
    } finally {
      directoryStatus = 200;
    }
  });

  it("explains disabled runtime logging after checking app access", async () => {
    const app = await createApp("logging-disabled");
    const path = `/apps/${app.id}/logs`;
    const reporting = vi.spyOn(environment.reporting, "exception");

    try {
      expect((await json(path, "GET", undefined, new Headers())).status).toBe(401);
      expect((await json(path, "GET", undefined, outsiderHeaders)).status).toBe(404);
      expect((await json(`/apps/${crypto.randomUUID()}/logs`, "GET")).status).toBe(404);
      expect((await json(`${path}?since=0s`, "GET")).status).toBe(400);

      const response = await json(path, "GET");
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        code: "TELEMETRY_NOT_CONFIGURED",
        message:
          "Runtime logging is not enabled for this installation. An administrator must enable telemetry.",
      });
      expect(reporting).not.toHaveBeenCalled();
    } finally {
      reporting.mockRestore();
    }
  });

  it.each([403, 500, 200])(
    "returns a safe telemetry failure when the logging backend replies with HTTP %s and invalid data",
    async (status) => {
      const app = await createApp(`logging-unavailable-${status}`);

      const upstream = createServer((request, response) => {
        request.resume();
        response.writeHead(status).end("private upstream query and credential details");
      });

      upstream.listen(0, "127.0.0.1");
      await once(upstream, "listening");

      const address = z.object({ port: z.number() }).parse(upstream.address());
      const previousUrl = environment.configuration.CLICKHOUSE_URL;
      const diagnostics = vi.spyOn(console, "error").mockImplementation(() => {});
      environment.configuration.CLICKHOUSE_URL = `http://127.0.0.1:${address.port}`;

      try {
        const response = await json(`/apps/${app.id}/logs`, "GET");
        const body = await response.text();
        expect(response.status).toBe(503);
        expect(JSON.parse(body)).toMatchObject({
          code: "TELEMETRY_UNAVAILABLE",
          message: "Runtime logs are temporarily unavailable. Please try again later.",
        });
        expect(body).not.toContain("private upstream");
        expect(body).not.toContain("127.0.0.1");
        expect(body).not.toContain("stack");
        expect(diagnostics).toHaveBeenCalledWith("API operation failed", expect.any(Error));
        expect(diagnostics.mock.calls[0]?.[1]).toHaveProperty("cause", expect.any(Error));
      } finally {
        environment.configuration.CLICKHOUSE_URL = previousUrl;
        diagnostics.mockRestore();
        upstream.closeAllConnections();
        await new Promise<void>((resolve, reject) => {
          upstream.close((cause) => (cause ? reject(cause) : resolve()));
        });
      }
    },
  );

  it.each([443, 25453])(
    "returns the app URL with HTTPS port %s across app endpoints",
    async (port) => {
      const previousPort = environment.configuration.APP_HTTPS_PORT;
      environment.configuration.APP_HTTPS_PORT = port;

      try {
        const app = await createApp(`url-${port}`);
        const expected = `https://${app.hostname}${port === 443 ? "" : `:${port}`}/`;
        expect(app.url).toBe(expected);
        expect((await start(app.id)).url).toBe(expected);
        expect(contract.app.parse(await (await json(`/apps/${app.id}`, "GET")).json()).url).toBe(
          expected,
        );
        expect(
          contract.app.parse(await (await json(`/apps/by-name/${app.slug}`, "PUT", {})).json()).url,
        ).toBe(expected);
        expect(
          z
            .array(contract.app)
            .parse(await (await json("/apps", "GET")).json())
            .find((item) => item.id === app.id)?.url,
        ).toBe(expected);
      } finally {
        environment.configuration.APP_HTTPS_PORT = previousPort;
      }
    },
  );

  it("keeps app identity independent of agent registration and replacement", async () => {
    const app = await createApp("stable-fleet");
    expect(app.fleetId).toBe(fleetId);
    expect(app.fleetId).not.toBe(agentId);

    const registration = z
      .object({ agent: contract.agent, token: z.string() })
      .parse(await (await json("/agents", "POST", { name: "Replacement executor" })).json());

    expect((await createApp("same-fleet")).fleetId).toBe(fleetId);
    await json(`/agents/${registration.agent.id}`, "DELETE");
    expect(contract.app.parse(await (await json(`/apps/${app.id}`, "GET")).json())).toEqual(app);
  });

  it("allows members to create apps while no executor is connected", async () => {
    expect(
      (
        await json(
          "/apps",
          "POST",
          { slug: "member-app", displayName: "Member App" },
          outsiderHeaders,
        )
      ).status,
    ).toBe(200);
    await environment.database.db
      .update(agents)
      .set({ enabled: false })
      .where(eq(agents.id, agentId));

    try {
      const response = await json("/apps", "POST", { slug: "no-host", displayName: "No host" });
      expect(response.status).toBe(200);
      expect((await json("/agent/jobs/claim", "POST", {}, agentHeaders)).status).toBe(403);
    } finally {
      await environment.database.db
        .update(agents)
        .set({ enabled: true })
        .where(eq(agents.id, agentId));
    }
  });

  it("resolves a configured name atomically and enforces app-specific permissions", async () => {
    const responses = await Promise.all([
      json("/apps/by-name/named-app", "PUT", {}),
      json("/apps/by-name/named-app", "PUT", {}),
    ]);

    const resolved = await Promise.all(
      responses.map(async (response) => {
        expect(response.status).toBe(200);

        return contract.app.parse(await response.json());
      }),
    );

    const app = contract.app.parse(resolved[0]);
    expect(resolved[1]?.id).toBe(app.id);
    expect(app.fleetId).toBe(fleetId);
    expect((await json("/apps/by-name/named-app", "PUT", {}, outsiderHeaders)).status).toBe(404);
    expect((await json("/apps/by-name/member-named-app", "PUT", {}, outsiderHeaders)).status).toBe(
      200,
    );
    expect((await json(`/apps/${app.id}/creators/${outsiderId}`, "PUT", {})).status).toBe(200);
    const permitted = await json("/apps/by-name/named-app", "PUT", {}, outsiderHeaders);
    expect(permitted.status).toBe(200);
    expect(contract.app.parse(await permitted.json()).id).toBe(app.id);
    expect((await json(`/apps/${app.id}/creators/${outsiderId}`, "DELETE", {})).status).toBe(200);
    const second = await json("/apps/by-name/another-name", "PUT", {});
    expect(second.status).toBe(200);
    expect(contract.app.parse(await second.json()).id).not.toBe(app.id);
    expect((await json("/apps/by-name/auth", "PUT", {})).status).toBe(400);
    await environment.database.db
      .update(apps)
      .set({ state: "deleting" })
      .where(eq(apps.id, app.id));
    expect((await json("/apps/by-name/named-app", "PUT", {})).status).toBe(409);
  });

  const start = async (appId: string, manifest: z.infer<typeof contract.assetManifest> = {}) => {
    const response = await json(`/apps/${appId}/assets-upload-session`, "POST", { manifest });
    expect(response.status).toBe(200);

    return contract.uploadSession.parse(await response.json());
  };

  const publish = (
    appId: string,
    sessionId: string,
    requestId = crypto.randomUUID(),
    code = "export default { fetch() { return new Response('ok'); } }",
    credentials = adminHeaders,
    bindings: z.infer<typeof contract.workerMetadata>["bindings"] = [],
  ) => {
    const form = new FormData();
    form.set(
      "metadata",
      JSON.stringify({
        main_module: "worker.js",
        compatibility_date: "2026-10-01",
        assets: { upload_session: sessionId },
        bindings,
      }),
    );
    form.set("worker.js", new Blob([code], { type: "application/javascript+module" }), "worker.js");
    const headers = new Headers(credentials);
    headers.set("origin", environment.configuration.PLATFORM_URL);
    headers.set("idempotency-key", requestId);

    return api(
      new Request(`${environment.configuration.PLATFORM_URL}/api/v1/apps/${appId}/worker`, {
        method: "PUT",
        headers,
        body: form,
      }),
    );
  };

  it("enforces app visibility, creator rights and unique names under concurrent requests", async () => {
    const responses = await Promise.all([
      json("/apps", "POST", { slug: "permissions", displayName: "Permissions" }),
      json("/apps", "POST", { slug: "permissions", displayName: "Permissions" }),
    ]);

    expect(
      responses.map((response) => response.status).sort((left, right) => left - right),
    ).toEqual([200, 409]);
    const listed = await json("/apps", "GET");
    const records = z.array(contract.app).parse(await listed.json());
    const app = records.find((record) => record.slug === "permissions");
    expect(app).toBeDefined();

    if (!app) throw new Error("App was not created");
    expect((await json(`/apps/${app.id}`, "GET", undefined, outsiderHeaders)).status).toBe(404);

    const memberApps = z
      .array(contract.app)
      .parse(await (await json("/apps", "GET", undefined, outsiderHeaders)).json());

    expect(memberApps.map((record) => record.slug).sort()).toEqual([
      "member-app",
      "member-named-app",
    ]);
    expect(
      (
        await json(
          "/apps",
          "POST",
          { slug: "member-owned", displayName: "Member Owned" },
          outsiderHeaders,
        )
      ).status,
    ).toBe(200);
  });

  it("validates and deduplicates assets, then publishes an immutable multipart worker idempotently", async () => {
    const app = await createApp("upload");
    const bytes = new TextEncoder().encode("hello");
    const hash = hashAsset("/index.html", bytes);
    const manifest = { "/index.html": { hash, size: bytes.byteLength } };
    const session = await start(app.id, manifest);
    expect(session.missing).toEqual([hash]);
    expect((await publish(app.id, session.id)).status).toBe(409);

    const put = (content: Uint8Array, credentials = adminHeaders) => {
      const headers = new Headers(credentials);
      headers.set("origin", environment.configuration.PLATFORM_URL);
      headers.set("content-type", "application/octet-stream");

      return api(
        new Request(
          `${environment.configuration.PLATFORM_URL}/api/v1/apps/${app.id}/assets/${session.id}/${hash}`,
          { method: "PUT", headers, body: Buffer.from(content) },
        ),
      );
    };

    expect((await put(new TextEncoder().encode("wrong"))).status).toBe(400);
    expect((await put(bytes, outsiderHeaders)).status).toBe(404);
    expect((await put(bytes)).status).toBe(200);
    expect((await put(bytes)).status).toBe(200);
    expect((await start(app.id, manifest)).missing).toEqual([]);
    const requestId = crypto.randomUUID();
    const first = await publish(app.id, session.id, requestId);
    expect(first.status).toBe(200);
    const deployment = contract.deployment.parse(await first.json());
    const retry = await publish(app.id, session.id, requestId);
    expect(retry.status).toBe(200);
    expect(contract.deployment.parse(await retry.json()).id).toBe(deployment.id);
    expect((await publish(app.id, session.id, requestId, "export default {};")).status).toBe(409);

    const history = z
      .array(contract.deployment)
      .parse(await (await json(`/apps/${app.id}/deployments`, "GET")).json());

    expect(history).toHaveLength(1);
  });

  it("serializes conflicting concurrent publishes for the same build identity", async () => {
    const app = await createApp("concurrent-build");
    const sessions = await Promise.all([start(app.id), start(app.id)]);

    const responses = await Promise.all(
      sessions.map((session, index) => {
        const form = new FormData();
        form.set(
          "metadata",
          JSON.stringify({
            main_module: "worker.js",
            compatibility_date: "2026-10-01",
            assets: { upload_session: session.id },
            debug: {
              build_id: "concurrent-version",
              source_maps: { "worker.js": "worker.js.map" },
            },
          }),
        );
        form.set(
          "worker.js",
          new Blob([`export default { version: ${index} };`], {
            type: "application/javascript+module",
          }),
          "worker.js",
        );
        form.set(
          "worker.js.map",
          new Blob(
            [
              JSON.stringify({
                version: 3,
                sources: [`source-${index}.js`],
                names: [],
                mappings: "AAAA",
              }),
            ],
            { type: "application/source-map+json" },
          ),
          "worker.js.map",
        );
        const headers = new Headers(adminHeaders);
        headers.set("origin", environment.configuration.PLATFORM_URL);
        headers.set("idempotency-key", crypto.randomUUID());

        return api(
          new Request(`${environment.configuration.PLATFORM_URL}/api/v1/apps/${app.id}/worker`, {
            method: "PUT",
            headers,
            body: form,
          }),
        );
      }),
    );

    expect(
      responses.map((response) => response.status).sort((left, right) => left - right),
    ).toEqual([200, 409]);

    const stored = await environment.database.db
      .select()
      .from(artifacts)
      .where(eq(artifacts.appId, app.id));

    expect(stored).toHaveLength(1);
    expect(stored[0]?.metadata).toHaveProperty("debug.build_id", "concurrent-version");
  });

  it("stores source maps privately and rejects mismatched or changed debug artifacts", async () => {
    const app = await createApp("source-maps");
    const session = await start(app.id);
    const requestId = crypto.randomUUID();

    const sourceMap = JSON.stringify({
      version: 3,
      sources: ["src/routes/+page.server.ts"],
      names: [],
      mappings: "AAAA",
      sourcesContent: ["throw new Error('private fixture');"],
    });

    const upload = (
      map = sourceMap,
      mapName = "worker.js.map",
      credentials = adminHeaders,
      generated = "worker.js",
    ) => {
      const form = new FormData();
      form.set(
        "metadata",
        JSON.stringify({
          main_module: "worker.js",
          compatibility_date: "2026-10-01",
          assets: { upload_session: session.id },
          debug: { build_id: "fixture-version", source_maps: { [generated]: "worker.js.map" } },
        }),
      );
      form.set(
        "worker.js",
        new Blob(["export default {};"], { type: "application/javascript+module" }),
        "worker.js",
      );
      form.set(mapName, new Blob([map], { type: "application/source-map+json" }), mapName);
      const headers = new Headers(credentials);
      headers.set("origin", environment.configuration.PLATFORM_URL);
      headers.set("idempotency-key", requestId);

      return api(
        new Request(`${environment.configuration.PLATFORM_URL}/api/v1/apps/${app.id}/worker`, {
          method: "PUT",
          headers,
          body: form,
        }),
      );
    };

    expect((await upload(sourceMap, "worker.js.map", outsiderHeaders)).status).toBe(404);
    expect((await upload("not JSON")).status).toBe(400);
    expect((await upload(sourceMap, "unreferenced.map")).status).toBe(400);
    const response = await upload();
    expect(response.status).toBe(200);
    const deployment = contract.deployment.parse(await response.json());
    expect(contract.deployment.parse(await (await upload()).json()).id).toBe(deployment.id);
    expect((await upload(sourceMap, "worker.js.map", adminHeaders, "different.js")).status).toBe(
      409,
    );
    expect((await upload(sourceMap.replace("private fixture", "changed fixture"))).status).toBe(
      409,
    );

    const [stored] = await environment.database.db
      .select()
      .from(artifacts)
      .where(eq(artifacts.id, deployment.artifactId));

    expect(stored?.manifest).toEqual({});
    expect(stored?.metadata).toHaveProperty("debug.build_id", "fixture-version");
    expect(stored?.modules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "worker.js.map", type: "sourcemap" }),
      ]),
    );

    const inventory = await s3.send(
      new ListObjectsV2Command({
        Bucket: environment.configuration.S3_BUCKET,
        Prefix: `apps/${app.id}/assets/`,
      }),
    );

    expect(inventory.Contents ?? []).toHaveLength(0);
  });

  it("grants app-specific access and revokes it without renewing the user's session", async () => {
    const app = await createApp("shared");
    const permissionPath = `/apps/${app.id}/creators/${outsiderId}`;
    expect((await json(`/apps/${app.id}/creators/missing-user`, "PUT", {})).status).toBe(404);
    expect((await json(permissionPath, "PUT", {})).status).toBe(200);
    expect((await json(`/apps/${app.id}`, "GET", undefined, outsiderHeaders)).status).toBe(200);
    expect(
      (
        await json(
          `/apps/${app.id}/assets-upload-session`,
          "POST",
          { manifest: {} },
          outsiderHeaders,
        )
      ).status,
    ).toBe(200);
    expect((await json(permissionPath, "DELETE", undefined, outsiderHeaders)).status).toBe(403);
    expect((await json(permissionPath, "DELETE")).status).toBe(200);
    expect((await json(`/apps/${app.id}`, "GET", undefined, outsiderHeaders)).status).toBe(404);
    expect(
      (
        await json(
          `/apps/${app.id}/assets-upload-session`,
          "POST",
          { manifest: {} },
          outsiderHeaders,
        )
      ).status,
    ).toBe(404);
  });

  it("serializes jobs per fleet, fences expired leases, and preserves retry acknowledgments after hard deletion", async () => {
    // Drain the earlier upload test's independent app before checking this app's queue.
    let pending = contract.job
      .nullable()
      .parse(await (await json("/agent/jobs/claim", "POST", {}, agentHeaders)).json());

    while (pending) {
      expect(
        (
          await json(
            `/agent/jobs/${pending.id}/complete`,
            "POST",
            { leaseToken: pending.leaseToken, outcome: "failed", message: "Fixture cleanup" },
            agentHeaders,
          )
        ).status,
      ).toBe(200);
      pending = contract.job
        .nullable()
        .parse(await (await json("/agent/jobs/claim", "POST", {}, agentHeaders)).json());
    }

    const app = await createApp("jobs");
    const firstSession = await start(app.id);
    const first = contract.deployment.parse(await (await publish(app.id, firstSession.id)).json());
    const secondSession = await start(app.id);

    const second = contract.deployment.parse(
      await (await publish(app.id, secondSession.id)).json(),
    );

    const claimed = await Promise.all([
      json("/agent/jobs/claim", "POST", {}, agentHeaders),
      json("/agent/jobs/claim", "POST", {}, agentHeaders),
    ]);

    const claims = await Promise.all(
      claimed.map(async (response) => contract.job.nullable().parse(await response.json())),
    );

    expect(claims.filter((entry) => entry !== null)).toHaveLength(1);
    const claim = claims.find((entry) => entry !== null);

    if (!claim) throw new Error("No job was claimed");
    expect(claim.deploymentId).toBe(first.id);
    await environment.database.db
      .update(jobs)
      .set({ leaseUntil: new Date(0) })
      .where(eq(jobs.id, claim.id));

    const retry = contract.job.parse(
      await (await json("/agent/jobs/claim", "POST", {}, agentHeaders)).json(),
    );

    expect(retry.id).toBe(claim.id);
    expect(retry.leaseToken).not.toBe(claim.leaseToken);
    expect(
      (
        await json(
          `/agent/jobs/${claim.id}/complete`,
          "POST",
          { leaseToken: claim.leaseToken, outcome: "succeeded", message: "Stale completion" },
          agentHeaders,
        )
      ).status,
    ).toBe(409);

    const artifact = await json(
      `/agent/jobs/${retry.id}/artifact?leaseToken=${retry.leaseToken}`,
      "GET",
      undefined,
      agentHeaders,
    );

    expect(artifact.status).toBe(200);
    expect(contract.artifact.parse(await artifact.json()).id).toBe(first.artifactId);
    expect(
      (
        await json(
          `/agent/jobs/${retry.id}/complete`,
          "POST",
          { leaseToken: retry.leaseToken, outcome: "succeeded", message: "Activated" },
          agentHeaders,
        )
      ).status,
    ).toBe(200);

    const next = contract.job.parse(
      await (await json("/agent/jobs/claim", "POST", {}, agentHeaders)).json(),
    );

    expect(next.deploymentId).toBe(second.id);
    const previews = [];

    for (const previewName of [undefined, "review"]) {
      const preview = contract.app.parse(
        await (
          await json("/apps", "POST", {
            slug: previewName ? "jobs-named-preview" : "jobs-flat-preview",
            displayName: "Deletion Preview",
            parentId: app.id,
            previewName,
          })
        ).json(),
      );

      const bytes = new TextEncoder().encode("preview asset");
      const hash = hashAsset("/index.html", bytes);

      const session = await start(preview.id, {
        "/index.html": { hash, size: bytes.byteLength },
      });

      const headers = new Headers(adminHeaders);
      headers.set("origin", environment.configuration.PLATFORM_URL);
      headers.set("content-type", "application/octet-stream");

      const upload = await api(
        new Request(
          `${environment.configuration.PLATFORM_URL}/api/v1/apps/${preview.id}/assets/${session.id}/${hash}`,
          { method: "PUT", headers, body: bytes },
        ),
      );

      expect(upload.status).toBe(200);

      const stored = await s3.send(
        new ListObjectsV2Command({
          Bucket: environment.configuration.S3_BUCKET,
          Prefix: `apps/${preview.id}/`,
        }),
      );

      expect(stored.Contents).toHaveLength(1);
      previews.push(preview);
    }

    // Older servers allowed nested previews; newer creation rejects them.
    const nested = await createApp("jobs-nested-preview");
    const legacyParent = previews[0]?.id;

    if (!legacyParent) throw new Error("Missing preview fixture");
    await environment.database.db
      .update(apps)
      .set({ parentId: legacyParent })
      .where(eq(apps.id, nested.id));
    previews.push({ ...nested, parentId: legacyParent });

    expect((await json(`/apps/${app.id}`, "DELETE")).status).toBe(200);
    expect((await json(`/apps/${app.id}`, "DELETE")).status).toBe(200);

    for (const preview of previews) {
      expect(
        contract.app.parse(await (await json(`/apps/${preview.id}`, "GET")).json()),
      ).toMatchObject({ state: "deleting", parentId: preview.parentId });
      expect(
        (await json(`/apps/${preview.id}/assets-upload-session`, "POST", { manifest: {} })).status,
      ).toBe(409);
    }

    expect(
      (
        await json(
          `/agent/jobs/${next.id}/complete`,
          "POST",
          { leaseToken: next.leaseToken, outcome: "succeeded", message: "Activated" },
          agentHeaders,
        )
      ).status,
    ).toBe(200);
    expect(contract.app.parse(await (await json(`/apps/${app.id}`, "GET")).json()).state).toBe(
      "deleting",
    );
    expect(
      (await json(`/apps/${app.id}/assets-upload-session`, "POST", { manifest: {} })).status,
    ).toBe(409);

    const removalOrder = [nested.id, ...previews.slice(0, 2).map((preview) => preview.id)];
    const removed = [];

    for (let index = 0; index < previews.length + 1; index += 1) {
      let deletion = contract.job.parse(
        await (await json("/agent/jobs/claim", "POST", {}, agentHeaders)).json(),
      );

      expect(deletion.kind).toBe("delete");

      if (index === 0) {
        expect(deletion.appId).toBe(nested.id);
        expect(
          (
            await json(
              `/agent/jobs/${deletion.id}/complete`,
              "POST",
              {
                leaseToken: deletion.leaseToken,
                outcome: "failed",
                message: "Retry teardown",
              },
              agentHeaders,
            )
          ).status,
        ).toBe(200);

        const retryDeletion = contract.job.parse(
          await (await json("/agent/jobs/claim", "POST", {}, agentHeaders)).json(),
        );

        expect(retryDeletion.id).toBe(deletion.id);
        expect(retryDeletion.leaseToken).not.toBe(deletion.leaseToken);
        deletion = retryDeletion;
      }

      if (index === previews.length) expect(deletion.appId).toBe(app.id);
      else expect(removalOrder).toContain(deletion.appId);

      const body = { leaseToken: deletion.leaseToken, outcome: "succeeded", message: "Removed" };
      const reportsBeforeDeletion = reportedOperations.length;
      expect(
        (await json(`/agent/jobs/${deletion.id}/complete`, "POST", body, agentHeaders)).status,
      ).toBe(200);
      expect(
        (await json(`/agent/jobs/${deletion.id}/complete`, "POST", body, agentHeaders)).status,
      ).toBe(200);
      expect((await json(`/apps/${deletion.appId}`, "GET")).status).toBe(404);
      expect(reportedOperations).toHaveLength(reportsBeforeDeletion + 1);
      expect(reportedOperations.at(-1)).toMatchObject({
        operation: "delete",
        outcome: "succeeded",
      });
      removed.push(deletion.appId);

      const remaining = await s3.send(
        new ListObjectsV2Command({
          Bucket: environment.configuration.S3_BUCKET,
          Prefix: `apps/${deletion.appId}/`,
        }),
      );

      expect(remaining.Contents ?? []).toHaveLength(0);
    }

    expect(new Set(removed)).toEqual(new Set([app.id, ...removalOrder]));
    expect(await (await json("/agent/jobs/claim", "POST", {}, agentHeaders)).json()).toBeNull();
  });

  it("cleans up previews when completing a deletion queued before cascade cleanup", async () => {
    const parent = await createApp("legacy-deletion");

    const preview = contract.app.parse(
      await (
        await json("/apps", "POST", {
          slug: "legacy-deletion-preview",
          displayName: "Legacy Preview",
          parentId: parent.id,
        })
      ).json(),
    );

    await environment.database.db
      .update(apps)
      .set({ state: "deleting" })
      .where(eq(apps.id, parent.id));
    await environment.database.db.insert(jobs).values({
      id: crypto.randomUUID(),
      appId: parent.id,
      fleetId: parent.fleetId,
      kind: "delete",
    });

    const deletion = contract.job.parse(
      await (await json("/agent/jobs/claim", "POST", {}, agentHeaders)).json(),
    );

    expect(deletion.appId).toBe(parent.id);
    expect(
      (
        await json(
          `/agent/jobs/${deletion.id}/complete`,
          "POST",
          {
            leaseToken: deletion.leaseToken,
            outcome: "succeeded",
            message: "Removed parent",
          },
          agentHeaders,
        )
      ).status,
    ).toBe(200);
    expect((await json(`/apps/${parent.id}`, "GET")).status).toBe(404);
    expect(
      contract.app.parse(await (await json(`/apps/${preview.id}`, "GET")).json()),
    ).toMatchObject({ state: "deleting", parentId: parent.id });

    const previewDeletion = contract.job.parse(
      await (await json("/agent/jobs/claim", "POST", {}, agentHeaders)).json(),
    );

    expect(previewDeletion.appId).toBe(preview.id);
    expect(previewDeletion.kind).toBe("delete");
    expect(
      (
        await json(
          `/agent/jobs/${previewDeletion.id}/complete`,
          "POST",
          {
            leaseToken: previewDeletion.leaseToken,
            outcome: "succeeded",
            message: "Removed preview",
          },
          agentHeaders,
        )
      ).status,
    ).toBe(200);
    expect((await json(`/apps/${preview.id}`, "GET")).status).toBe(404);
  });

  it("provides the deploy URL to write-only tokens while preserving read and app permissions", async () => {
    const app = await createApp("write-only");
    expect((await json(`/apps/${app.id}/creators/${outsiderId}`, "PUT", {})).status).toBe(200);
    const now = Math.floor(Date.now() / 1000);

    const { token } = await environment.auth.api.signJWT({
      body: {
        payload: {
          sub: outsiderId,
          aud: apiResource(environment.configuration),
          iss: `${environment.configuration.PLATFORM_URL}/api/auth`,
          iat: now,
          exp: now + 300,
          scope: "platform:write",
        },
      },
    });

    const credentials = new Headers({ authorization: `Bearer ${token}` });
    expect((await json(`/apps/${app.id}`, "GET", undefined, credentials)).status).toBe(403);
    const directoryCalls = directoryRequests.length;
    expect((await json("/groups?query=Einkauf", "GET", undefined, credentials)).status).toBe(403);
    expect(directoryRequests).toHaveLength(directoryCalls);

    const response = await json(
      `/apps/${app.id}/assets-upload-session`,
      "POST",
      { manifest: {} },
      credentials,
    );

    expect(response.status).toBe(200);
    const session = contract.uploadSession.parse(await response.json());
    expect(session.url).toBe(app.url);
    const deployed = await publish(app.id, session.id, crypto.randomUUID(), undefined, credentials);
    expect(deployed.status).toBe(200);
    expect(contract.deployment.parse(await deployed.json())).toMatchObject({
      appId: app.id,
      status: "queued",
    });

    const denied = await createApp("write-only-denied");
    expect(
      (
        await json(
          `/apps/${denied.id}/assets-upload-session`,
          "POST",
          { manifest: {} },
          credentials,
        )
      ).status,
    ).toBe(404);
  });

  it("publishes a generated OpenAPI contract for the authenticated management API", async () => {
    const response = await json("/openapi.json", "GET");
    expect(response.status).toBe(200);

    const spec = z
      .object({ paths: z.record(z.string(), z.unknown()) })
      .parse(await response.json());

    expect(spec.paths["/apps"]).toBeDefined();
    expect(spec.paths["/agent/jobs/{jobId}/complete"]).toBeDefined();
    expect(spec.paths["/apps/{appId}/worker"]).toBeDefined();
    expect(spec.paths["/apps/{appId}/assets/{sessionId}/{hash}"]).toBeDefined();
    expect(spec.paths["/agent/jobs/{jobId}/migrations/{sha256}"]).toBeDefined();

    const logs = z
      .object({ get: z.object({ responses: z.record(z.string(), z.json()) }) })
      .parse(spec.paths["/apps/{appId}/logs"]);

    const unavailable = JSON.stringify(logs.get.responses["503"]);
    expect(unavailable).toContain("TELEMETRY_NOT_CONFIGURED");
    expect(unavailable).toContain("TELEMETRY_UNAVAILABLE");
  });

  it("rolls back database writes when an operation returns an expected error", async () => {
    const id = crypto.randomUUID();

    const result = await transact(environment.database.db, async (transaction) => {
      await transaction
        .insert(agents)
        .values({ id, fleetId, name: "Aborted agent", tokenHash: crypto.randomUUID() });

      return Result.err(new InvalidOperation({ code: "CONFLICT", message: "Abort after write" }));
    });

    expect(result.isErr()).toBe(true);
    expect(await environment.database.db.select().from(agents).where(eq(agents.id, id))).toEqual(
      [],
    );
  });
  it.each(["0008_app_network.sql", "0009_it_connectors.sql"])(
    "rejects an in-use foundation before %s",
    async (file) => {
      const migration = await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8");

      const guard = z.string().parse(migration.split("--> statement-breakpoint")[0]);
      const client = new pg.Client({ connectionString: environment.configuration.DATABASE_URL });
      await client.connect();

      try {
        await client.query("BEGIN");
        await client.query(
          "CREATE TEMP TABLE app (id integer); CREATE TEMP TABLE fleet (runtime jsonb); CREATE TEMP TABLE job (state text)",
        );
        await client.query(guard);

        for (const fixture of [
          "INSERT INTO app VALUES (1)",
          "INSERT INTO fleet VALUES ('{}')",
          "INSERT INTO job VALUES ('running')",
        ]) {
          await client.query("SAVEPOINT fixture");
          await client.query(fixture);
          await expect(client.query(guard)).rejects.toThrow("require a fresh shared fleet");
          await client.query("ROLLBACK TO SAVEPOINT fixture");
        }
      } finally {
        await client.query("ROLLBACK");
        await client.end();
      }
    },
  );

  it.each(["create", "restart"])("authorizes Workflow %s through agent jobs", async (action) => {
    const app = await createApp(`workflow-management-${action}`);
    const base = `/apps/${app.id}/workflows`;

    const input = {
      request:
        action === "create"
          ? { action, workflow: "example", id: "run-1", params: { value: 1 } }
          : {
              action,
              workflow: "example",
              id: "run-1",
              from: { name: "aggregate", count: 2, type: "do" },
            },
    };

    expect((await json(base, "POST", input, outsiderHeaders, crypto.randomUUID())).status).toBe(
      404,
    );
    expect((await json(base, "POST", input, adminHeaders, crypto.randomUUID())).status).toBe(409);
    const session = await start(app.id);

    const declaration = {
      type: "workflow",
      name: "WORKFLOW",
      workflow_name: "example",
      class_name: "Example",
    };

    const deployment = contract.deployment.parse(
      await (
        await publish(app.id, session.id, crypto.randomUUID(), undefined, adminHeaders, [
          contract.workerBinding.parse(declaration),
        ])
      ).json(),
    );

    await environment.database.db
      .update(jobs)
      .set({ state: "succeeded" })
      .where(eq(jobs.deploymentId, deployment.id));
    await environment.database.db
      .update(apps)
      .set({
        activeDeploymentId: deployment.id,
        state: "active",
        networkRevision: 3,
        appliedNetworkRevision: 2,
      })
      .where(eq(apps.id, app.id));
    expect(await (await json(base, "GET")).json()).toEqual([declaration]);
    expect(
      (await json(`${base}/query`, "POST", input, adminHeaders, crypto.randomUUID())).status,
    ).toBe(400);
    const requestId = crypto.randomUUID();
    const response = await json(base, "POST", input, adminHeaders, requestId);
    expect(response.status).toBe(200);
    const operation = contract.workflowOperation.parse(await response.json());
    expect(operation).toMatchObject({ id: requestId, state: "queued", result: null });
    expect(await (await json(base, "POST", input, adminHeaders, requestId)).json()).toEqual(
      operation,
    );
    expect(
      (
        await json(
          base,
          "POST",
          { request: { ...input.request, id: "other" } },
          adminHeaders,
          requestId,
        )
      ).status,
    ).toBe(409);
    expect(
      (await json(`${base}/operations/${requestId}`, "GET", undefined, outsiderHeaders)).status,
    ).toBe(404);
    const other = await createApp(`workflow-elsewhere-${action}`);
    expect((await json(`/apps/${other.id}/workflows/operations/${requestId}`, "GET")).status).toBe(
      404,
    );
    const [before] = await environment.database.db.select().from(apps).where(eq(apps.id, app.id));

    if (!before) throw new Error("Missing workflow fixture app");
    const now = Math.floor(Date.now() / 1000);

    const signed = await environment.auth.api.signJWT({
      body: {
        payload: {
          sub: before.ownerId,
          aud: apiResource(environment.configuration),
          iss: `${environment.configuration.PLATFORM_URL}/api/auth`,
          iat: now,
          exp: now + 300,
          scope: "platform:read",
        },
      },
    });

    const readHeaders = new Headers({ authorization: `Bearer ${signed.token}` });
    expect((await json(base, "POST", input, readHeaders, crypto.randomUUID())).status).toBe(403);
    expect(
      (
        await json(
          `${base}/query`,
          "POST",
          { request: { action: "status", workflow: "example", id: "run-1" } },
          readHeaders,
          crypto.randomUUID(),
        )
      ).status,
    ).toBe(200);
    expect(
      (await json(`${base}/operations/${requestId}`, "GET", undefined, readHeaders)).status,
    ).toBe(200);

    await environment.database.db
      .update(jobs)
      .set({ state: "succeeded" })
      .where(sql`${jobs.id} <> ${requestId} AND ${jobs.state} IN ('queued', 'running')`);

    const lease = contract.job.parse(
      await (await json("/agent/jobs/claim", "POST", undefined, agentHeaders)).json(),
    );

    expect(lease).toMatchObject({
      id: requestId,
      kind: "workflows",
      workflow: input.request,
      deploymentId: null,
    });
    expect(
      (
        await json(
          `/agent/jobs/${requestId}/complete`,
          "POST",
          {
            leaseToken: lease.leaseToken,
            outcome: "succeeded",
            message: "Created",
            workflow: { id: "run-1" },
          },
          agentHeaders,
        )
      ).status,
    ).toBe(200);
    expect(await (await json(`${base}/operations/${requestId}`, "GET")).json()).toMatchObject({
      state: "succeeded",
      result: { id: "run-1" },
    });
    const [after] = await environment.database.db.select().from(apps).where(eq(apps.id, app.id));
    expect(after).toEqual(before);
  });

  it("authorizes and records explicit migration jobs without activating code or permissions", async () => {
    const app = await createApp("migration-access");
    const path = `/apps/${app.id}/migrations`;

    const input = {
      action: "apply",
      database: "DB",
      databaseId: "fixture",
      table: "d1_migrations",
      files: [
        { name: "20261008120000_initial/migration.sql", sql: "CREATE TABLE example (id INTEGER);" },
      ],
    };

    expect((await json(path, "POST", input, outsiderHeaders, crypto.randomUUID())).status).toBe(
      404,
    );
    expect((await json(path, "POST", input, adminHeaders, crypto.randomUUID())).status).toBe(409);
    const session = await start(app.id);

    const deployment = contract.deployment.parse(
      await (
        await publish(app.id, session.id, crypto.randomUUID(), undefined, adminHeaders, [
          { type: "d1", name: "DB", database_name: "fixture" },
        ])
      ).json(),
    );

    await environment.database.db
      .update(jobs)
      .set({ state: "succeeded" })
      .where(eq(jobs.deploymentId, deployment.id));
    await environment.database.db
      .update(apps)
      .set({
        activeDeploymentId: deployment.id,
        state: "active",
        networkRevision: 2,
        appliedNetworkRevision: 1,
      })
      .where(eq(apps.id, app.id));

    expect(
      (
        await json(
          path,
          "POST",
          { ...input, databaseId: "another-app" },
          adminHeaders,
          crypto.randomUUID(),
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await json(
          path,
          "POST",
          { ...input, table: "table; DROP TABLE app" },
          adminHeaders,
          crypto.randomUUID(),
        )
      ).status,
    ).toBe(400);
    expect(
      (await json(path, "POST", { ...input, action: "list" }, adminHeaders, crypto.randomUUID()))
        .status,
    ).toBe(400);
    expect(
      (
        await json(
          path,
          "POST",
          { ...input, files: [input.files[0], input.files[0]] },
          adminHeaders,
          crypto.randomUUID(),
        )
      ).status,
    ).toBe(400);
    const key = crypto.randomUUID();
    const bytes = Buffer.from(JSON.stringify(contract.migrationRequest.parse(input)));

    const reference = {
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.length,
    };

    const artifactKey = `apps/${app.id}/migrations/${reference.sha256}`;

    const upload = vi
      .spyOn(storage, "put")
      .mockResolvedValueOnce(
        Result.err(new StorageUnavailable({ message: "Synthetic upload failure", cause: null })),
      );

    try {
      expect((await json(path, "POST", input, adminHeaders, key)).status).toBe(503);
      expect(await environment.database.db.select().from(jobs).where(eq(jobs.id, key))).toEqual([]);
      expect((await storage.exists(artifactKey)).unwrap()).toBe(false);
    } finally {
      upload.mockRestore();
    }

    // A failed database commit can leave an uploaded object. A retry must safely reuse it.
    await environment.database.db.execute(
      sql`ALTER TABLE job ADD CONSTRAINT reject_migration_fixture CHECK (kind <> 'migrations')`,
    );

    try {
      expect((await json(path, "POST", input, adminHeaders, key)).status).toBe(503);
      expect(await environment.database.db.select().from(jobs).where(eq(jobs.id, key))).toEqual([]);
      expect(Buffer.from((await storage.get(artifactKey)).unwrap())).toEqual(bytes);
    } finally {
      await environment.database.db.execute(
        sql`ALTER TABLE job DROP CONSTRAINT reject_migration_fixture`,
      );
    }

    const first = await json(path, "POST", input, adminHeaders, key);
    expect(first.status).toBe(200);
    const operation = contract.migrationOperation.parse(await first.json());
    expect(operation).toMatchObject({ id: key, state: "queued", entries: null });
    expect(await (await json(path, "POST", input, adminHeaders, key)).json()).toEqual(operation);

    const reordered = {
      files: input.files.map(({ name, sql }) => ({ sql, name })),
      table: input.table,
      databaseId: input.databaseId,
      database: input.database,
      action: input.action,
    };

    expect(await (await json(path, "POST", reordered, adminHeaders, key)).json()).toEqual(
      operation,
    );
    const [saved] = await environment.database.db.select().from(jobs).where(eq(jobs.id, key));
    expect(saved?.migration).toEqual(reference);

    const stored = await s3.send(
      new GetObjectCommand({ Bucket: environment.configuration.S3_BUCKET, Key: artifactKey }),
    );

    expect(await stored.Body?.transformToString()).toBe(bytes.toString());
    expect(
      (await json(path, "POST", { ...input, table: "other_history" }, adminHeaders, key)).status,
    ).toBe(409);
    expect((await json(`${path}/${key}`, "GET", undefined, outsiderHeaders)).status).toBe(404);
    const other = await createApp("migration-other");
    expect((await json(`/apps/${other.id}/migrations/${key}`, "GET")).status).toBe(404);

    const leaseToken = crypto.randomUUID();
    await environment.database.db
      .update(jobs)
      .set({ state: "running", agentId, leaseToken, leaseUntil: new Date(Date.now() + 90000) })
      .where(eq(jobs.id, key));

    const download = `/agent/jobs/${key}/migrations/${reference.sha256}`;

    const downloaded = await json(
      `${download}?leaseToken=${leaseToken}`,
      "GET",
      undefined,
      agentHeaders,
    );

    expect(downloaded.status).toBe(200);
    expect(Buffer.from(await downloaded.arrayBuffer())).toEqual(bytes);
    expect((await json(`${download}?leaseToken=${leaseToken}`, "GET")).status).toBe(401);
    expect(
      (await json(`${download}?leaseToken=${crypto.randomUUID()}`, "GET", undefined, agentHeaders))
        .status,
    ).toBe(409);
    expect(
      (
        await json(
          `/agent/jobs/${key}/migrations/${"0".repeat(64)}?leaseToken=${leaseToken}`,
          "GET",
          undefined,
          agentHeaders,
        )
      ).status,
    ).toBe(404);

    await environment.database.db
      .update(jobs)
      .set({ leaseUntil: new Date(0) })
      .where(eq(jobs.id, key));
    expect(
      (await json(`${download}?leaseToken=${leaseToken}`, "GET", undefined, agentHeaders)).status,
    ).toBe(409);
    await environment.database.db
      .update(jobs)
      .set({ leaseUntil: new Date(Date.now() + 90000) })
      .where(eq(jobs.id, key));

    const result = {
      leaseToken,
      outcome: "succeeded",
      message: "Applied",
      migrations: [{ name: input.files[0]?.name, applied: true }],
    };

    expect(
      (
        await json(
          `/agent/jobs/${key}/complete`,
          "POST",
          { ...result, leaseToken: crypto.randomUUID() },
          agentHeaders,
        )
      ).status,
    ).toBe(409);
    expect((await json(`/agent/jobs/${key}/complete`, "POST", result, agentHeaders)).status).toBe(
      200,
    );
    expect(
      (await json(`${download}?leaseToken=${leaseToken}`, "GET", undefined, agentHeaders)).status,
    ).toBe(409);
    expect((await json(`/agent/jobs/${key}/complete`, "POST", result, agentHeaders)).status).toBe(
      200,
    );
    expect(await (await json(`${path}/${key}`, "GET")).json()).toMatchObject({
      state: "succeeded",
      entries: result.migrations,
    });
    const [after] = await environment.database.db.select().from(apps).where(eq(apps.id, app.id));
    expect(after).toMatchObject({ activeDeploymentId: deployment.id, appliedNetworkRevision: 1 });
    expect((await json(`/apps/${app.id}/creators/${outsiderId}`, "PUT", {})).status).toBe(200);

    const listed = await json(
      path,
      "POST",
      { ...input, action: "list", files: input.files.map(({ name }) => ({ name })) },
      outsiderHeaders,
      crypto.randomUUID(),
    );

    expect(listed.status).toBe(200);
    const listing = contract.migrationOperation.parse(await listed.json());
    await environment.database.db
      .update(jobs)
      .set({ state: "failed" })
      .where(eq(jobs.id, listing.id));
  });

  it("reports failed code separately from permissions already active on the serving app", async () => {
    const app = await createApp("network-status");
    const session = await start(app.id);
    const active = contract.deployment.parse(await (await publish(app.id, session.id)).json());
    await environment.database.db
      .update(jobs)
      .set({ state: "succeeded" })
      .where(eq(jobs.deploymentId, active.id));
    await environment.database.db
      .update(apps)
      .set({ activeDeploymentId: active.id, state: "active", appliedNetworkRevision: 1 })
      .where(eq(apps.id, app.id));

    for (const revision of [1, 2]) {
      await environment.database.db
        .update(apps)
        .set({ networkRevision: revision })
        .where(eq(apps.id, app.id));
      const upload = await start(app.id);
      const deployment = contract.deployment.parse(await (await publish(app.id, upload.id)).json());
      const leaseToken = crypto.randomUUID();

      const [attempt] = await environment.database.db
        .update(jobs)
        .set({
          state: "running",
          agentId,
          leaseToken,
          leaseUntil: new Date(Date.now() + 90000),
          network: { revision, policy: { backend: [], browser: [] } },
        })
        .where(eq(jobs.deploymentId, deployment.id))
        .returning();

      if (!attempt) throw new Error("Missing deployment job");
      expect(
        (
          await json(
            `/agent/jobs/${attempt.id}/complete`,
            "POST",
            {
              leaseToken,
              outcome: "failed",
              message: "Synthetic code failure",
            },
            agentHeaders,
          )
        ).status,
      ).toBe(200);
      expect(await (await json(`/apps/${app.id}/network`, "GET")).json()).toMatchObject({
        state: revision === 1 ? "active" : "failed",
        error: revision === 1 ? null : "Synthetic code failure",
        appliedRevision: 1,
      });
    }
  });

  it("changes individual origins atomically with normal scoped credentials and app permissions", async () => {
    const app = await createApp("network-access");
    const [record] = await environment.database.db.select().from(apps).where(eq(apps.id, app.id));

    if (!record) throw new Error("Missing fixture app");

    const bearer = async (subject: string, scope: string) => {
      const now = Math.floor(Date.now() / 1000);

      const signed = await environment.auth.api.signJWT({
        body: {
          payload: {
            sub: subject,
            aud: apiResource(environment.configuration),
            iss: `${environment.configuration.PLATFORM_URL}/api/auth`,
            iat: now,
            exp: now + 300,
            scope,
          },
        },
      });

      return new Headers({ authorization: `Bearer ${signed.token}` });
    };

    const path = `/apps/${app.id}/network`;
    const change = { target: "backend", action: "allow", origins: ["https://api.example.test"] };
    const deployOnly = await bearer(record.ownerId, "platform:read platform:write");
    const combined = await bearer(record.ownerId, "platform:read platform:write network:manage");
    const outsider = await bearer(outsiderId, "platform:read platform:write network:manage");

    expect((await json(path, "PATCH", change, deployOnly)).status).toBe(403);
    expect((await json(path, "GET", undefined, deployOnly)).status).toBe(200);
    expect((await json(path, "PATCH", change, outsider)).status).toBe(404);
    expect((await json(`/apps/${app.id}/creators/${outsiderId}`, "PUT", {})).status).toBe(200);
    expect((await json(path, "PATCH", change, outsider)).status).toBe(403);
    expect((await json(path, "PATCH", change, combined)).status).toBe(200);
    expect(
      (await json(path, "PATCH", { ...change, origins: ["https://*.example.test"] }, combined))
        .status,
    ).toBe(400);
    expect(
      (await json(path, "PATCH", { ...change, origins: ["http://api.example.test"] }, combined))
        .status,
    ).toBe(400);

    const deniedCsrf = await api(
      new Request(`${apiResource(environment.configuration)}${path}`, {
        method: "PATCH",
        headers: adminHeaders,
        body: JSON.stringify(change),
      }),
    );

    expect(deniedCsrf.status).toBe(403);

    // Separate concurrent grants must not overwrite each other, and the list is
    // not artificially capped at 32 origins.
    const origins = Array.from({ length: 40 }, (_, index) => `https://api-${index}.example.test`);

    const granted = await Promise.all(
      origins.map((origin) =>
        json(
          path,
          "PATCH",
          {
            ...change,
            origins: [origin],
          },
          combined,
        ),
      ),
    );

    expect(granted.every((response) => response.status === 200)).toBe(true);
    const saved = contract.networkState.parse(await (await json(path, "GET")).json());
    expect(saved.policy.backend).toEqual([...origins, ...change.origins].sort());
    expect(saved.policy.browser).toEqual([]);
    expect(saved.state).toBe("saved");

    const repeated = contract.networkState.parse(
      await (await json(path, "PATCH", change, combined)).json(),
    );

    expect(repeated.revision).toBe(saved.revision);

    const removed = contract.networkState.parse(
      await (
        await json(
          path,
          "PATCH",
          {
            ...change,
            action: "deny",
            origins: [origins[0]],
          },
          combined,
        )
      ).json(),
    );

    expect(removed.policy.backend).not.toContain(origins[0]);
    expect(removed.policy.backend).toHaveLength(40);

    // A failed application can be retried with the same ordinary command.
    await environment.database.db
      .update(apps)
      .set({ networkError: "Synthetic activation failure" })
      .where(eq(apps.id, app.id));
    expect(await (await json(path, "GET")).json()).toMatchObject({ state: "failed" });

    const retry = contract.networkState.parse(
      await (await json(path, "PATCH", change, combined)).json(),
    );

    expect(retry.revision).toBe(removed.revision);
    expect(retry.error).toBeNull();
    expect(retry.state).toBe("saved");
  });
  it("deploys connectors with ordinary admin credentials and changes individual app bindings atomically", async () => {
    // Complete earlier API-only fixtures before checking this fleet's job order.
    while (true) {
      const pending = contract.job
        .nullable()
        .parse(await (await json("/agent/jobs/claim", "POST", {}, agentHeaders)).json());

      if (!pending) break;
      expect(
        (
          await json(
            `/agent/jobs/${pending.id}/complete`,
            "POST",
            { leaseToken: pending.leaseToken, outcome: "succeeded", message: "Fixture completed" },
            agentHeaders,
          )
        ).status,
      ).toBe(200);
    }

    const source =
      "import { WorkerEntrypoint } from 'cloudflare:workers'; export class Customers extends WorkerEntrypoint { listCustomers() { return []; } } export default Customers;";

    const release = contract.connectorPackage.parse({
      protocol: 1,
      name: "erp-api",
      main: "worker.js",
      entrypoints: ["Customers", "default"],
      modules: [
        { name: "worker.js", source, sha256: createHash("sha256").update(source).digest("hex") },
      ],
      configuration: {
        compatibility_date: "2026-10-01",
        d1_databases: [{ binding: "DB", database_name: "customers", database_id: "local" }],
      },
    });

    const path = "/connectors/erp-api";
    expect((await json(path, "PUT", release, outsiderHeaders)).status).toBe(403);
    expect(
      (
        await json(path, "PUT", {
          ...release,
          modules: [{ ...release.modules[0], sha256: "0".repeat(64) }],
        })
      ).status,
    ).toBe(400);

    const submitted = contract.connectorStatus.parse(
      await (await json(path, "PUT", release)).json(),
    );

    expect(
      (
        await json(path, "PUT", {
          ...release,
          configuration: {
            ...release.configuration,
            vars: { WIDEFLEET_SECRET_API_KEY: "reserved" },
          },
        })
      ).status,
    ).toBe(400);
    expect(
      (await json(path, "PUT", { ...release, entrypoints: ["default", "WIDEFLEET_Secrets"] }))
        .status,
    ).toBe(400);

    const repeated = contract.connectorStatus.parse(
      await (await json(path, "PUT", release)).json(),
    );

    expect(repeated.jobId).toBe(submitted.jobId);
    const app = await createApp("connector-api");
    const bindingPath = `/apps/${app.id}/bindings`;
    expect((await json(`${bindingPath}/ERP`, "PUT", { connector: release.name })).status).toBe(409);

    expect(
      (
        await json(`${bindingPath}/SECRET_READER`, "PUT", {
          connector: release.name,
          entrypoint: "WIDEFLEET_Secrets",
        })
      ).status,
    ).toBe(409);

    const pending = contract.job.parse(
      await (await json("/agent/jobs/claim", "POST", {}, agentHeaders)).json(),
    );

    expect(pending).toMatchObject({ kind: "connector", appId: null });

    const packages = contract.runtimePackages.parse(
      await (
        await json(
          `/agent/jobs/${pending.id}/packages?leaseToken=${pending.leaseToken}`,
          "GET",
          undefined,
          agentHeaders,
        )
      ).json(),
    );

    expect(packages.connectors).toEqual([release]);
    expect(
      (
        await json(
          `/agent/jobs/${pending.id}/complete`,
          "POST",
          { leaseToken: pending.leaseToken, outcome: "succeeded", message: "Installed" },
          agentHeaders,
        )
      ).status,
    ).toBe(200);
    expect(await (await json(path, "GET")).json()).toMatchObject({
      state: "succeeded",
      appliedChecksum: submitted.checksum,
    });
    expect(
      (await json(`${bindingPath}/ERP`, "PUT", { connector: release.name }, outsiderHeaders))
        .status,
    ).toBe(403);
    expect(
      (await json(`${bindingPath}/WIDEFLEET_LOADER`, "PUT", { connector: release.name })).status,
    ).toBe(400);

    const queuedApp = await createApp("connector-collision");
    const session = await start(queuedApp.id);

    const queued = contract.deployment.parse(
      await (
        await publish(
          queuedApp.id,
          session.id,
          crypto.randomUUID(),
          "export default { fetch() { return new Response('ok'); } }",
          adminHeaders,
          [{ type: "kv_namespace", name: "ERP", id: "local-erp" }],
        )
      ).json(),
    );

    for (const status of ["queued", "running"] as const) {
      await environment.database.db
        .update(deployments)
        .set({ status })
        .where(eq(deployments.id, queued.id));
      expect(
        (await json(`/apps/${queuedApp.id}/bindings/ERP`, "PUT", { connector: release.name }))
          .status,
      ).toBe(409);
      expect(await (await json(`/apps/${queuedApp.id}/bindings`, "GET")).json()).toMatchObject({
        revision: 0,
        grants: {},
      });
    }

    await environment.database.db
      .update(deployments)
      .set({ status: "failed" })
      .where(eq(deployments.id, queued.id));
    await environment.database.db
      .update(jobs)
      .set({ state: "failed" })
      .where(eq(jobs.deploymentId, queued.id));
    expect(
      (await json(`/apps/${queuedApp.id}/bindings/ERP`, "PUT", { connector: release.name })).status,
    ).toBe(200);

    const responses = await Promise.all(
      ["ERP", "SALES"].map((binding) =>
        json(`${bindingPath}/${binding}`, "PUT", { connector: release.name }),
      ),
    );

    expect(responses.every((response) => response.status === 200)).toBe(true);
    const bindings = contract.capabilityState.parse(await (await json(bindingPath, "GET")).json());
    expect(bindings).toMatchObject({
      state: "saved",
      revision: 2,
      grants: {
        ERP: { connector: release.name, entrypoint: "default" },
        SALES: { connector: release.name, entrypoint: "default" },
      },
    });
    expect(
      await (await json(`${bindingPath}/ERP`, "PUT", { connector: release.name })).json(),
    ).toMatchObject({ revision: bindings.revision });
    expect(
      (
        await json(`${bindingPath}/ERP`, "PUT", {
          connector: release.name,
          entrypoint: "Customers",
        })
      ).status,
    ).toBe(200);
    expect(
      (await json(path, "PUT", { ...release, entrypoints: ["Replacement", "default"] })).status,
    ).toBe(409);
    await json(`${bindingPath}/ERP`, "DELETE");
    const removed = contract.capabilityState.parse(await (await json(bindingPath, "GET")).json());
    expect(Object.keys(removed.grants)).toEqual(["SALES"]);
    expect(await (await json(`${bindingPath}/ERP`, "DELETE")).json()).toMatchObject({
      revision: removed.revision,
    });
    expect((await json("/connectors", "GET", undefined, outsiderHeaders)).status).toBe(403);
    expect(
      z.array(contract.connectorStatus).parse(await (await json("/connectors", "GET")).json()),
    ).toHaveLength(1);
  });
  it("preserves encrypted connector snapshots across login settings updates and failed activation", async () => {
    const path = "/connectors/erp-api";
    const secretPath = `${path}/secrets/API_KEY`;
    const firstValue = "synthetic-connector-secret-one";
    const secondValue = "synthetic-connector-secret-two";

    const claim = async () =>
      contract.job.parse(await (await json("/agent/jobs/claim", "POST", {}, agentHeaders)).json());

    const packages = async (job: z.infer<typeof contract.job>) =>
      contract.runtimePackages.parse(
        await (
          await json(
            `/agent/jobs/${job.id}/packages?leaseToken=${job.leaseToken}`,
            "GET",
            undefined,
            agentHeaders,
          )
        ).json(),
      );

    const complete = async (job: z.infer<typeof contract.job>, outcome: "succeeded" | "failed") => {
      expect(
        (
          await json(
            `/agent/jobs/${job.id}/complete`,
            "POST",
            {
              leaseToken: job.leaseToken,
              outcome,
              message: "Synthetic secret activation",
            },
            agentHeaders,
          )
        ).status,
      ).toBe(200);
    };

    while (true) {
      const pending = contract.job
        .nullable()
        .parse(await (await json("/agent/jobs/claim", "POST", {}, agentHeaders)).json());

      if (!pending) break;
      await complete(pending, "succeeded");
    }

    expect((await json(secretPath, "PUT", { value: firstValue }, outsiderHeaders)).status).toBe(
      403,
    );
    expect((await json(`${path}/secrets`, "GET", undefined, outsiderHeaders)).status).toBe(403);
    expect((await json(secretPath, "DELETE", undefined, outsiderHeaders)).status).toBe(403);
    expect(
      (await json(`${path}/secrets/WIDEFLEET_RESERVED`, "PUT", { value: firstValue })).status,
    ).toBe(400);
    expect((await json(secretPath, "PUT", { value: "" })).status).toBe(400);
    expect((await json(`${path}/secrets/__proto__`, "PUT", { value: firstValue })).status).toBe(
      400,
    );
    expect((await json(secretPath, "PUT", { value: "é".repeat(32769) })).status).toBe(400);

    const loginSecrets = await environment.database.db.select().from(installationSecrets);

    const first = contract.connectorStatus.parse(
      await (await json(secretPath, "PUT", { value: firstValue })).json(),
    );

    expect(first).toMatchObject({
      secrets: ["API_KEY"],
      secretRevision: 1,
      appliedSecretRevision: 0,
      state: "queued",
    });
    expect(JSON.stringify(first)).not.toContain(firstValue);
    const leased = await claim();
    expect(leased.id).toBe(first.jobId);

    const second = contract.connectorStatus.parse(
      await (await json(secretPath, "PUT", { value: secondValue })).json(),
    );

    expect(second.secretRevision).toBe(2);
    expect(await environment.database.db.select().from(installationSecrets)).toEqual(loginSecrets);
    // Saving unchanged login settings still runs its credential cleanup. Both
    // the claimed and newer queued connector snapshots must remain decryptable.
    const owner = { ...environment.owner, role: "owner" as const, admin: true, creator: true };

    const settings = contract.settingsInput.parse(
      (await environment.settings.read(owner)).settings,
    );

    await environment.settings.update(owner, { ...settings, acknowledgeRestart: false }, true);
    const snapshot = await packages(leased);
    expect(snapshot.connectorSecrets["erp-api"]).toEqual({ API_KEY: firstValue });
    expect(JSON.stringify(snapshot.connectors)).not.toContain(firstValue);
    expect(
      (
        await json(
          `/agent/jobs/${leased.id}/packages?leaseToken=${crypto.randomUUID()}`,
          "GET",
          undefined,
          agentHeaders,
        )
      ).status,
    ).toBe(409);
    expect(
      (await json(`/agent/jobs/${leased.id}/packages?leaseToken=${leased.leaseToken}`, "GET"))
        .status,
    ).not.toBe(200);

    const persisted = JSON.stringify([
      await environment.database.db.select().from(installationSecrets),
      await environment.database.db.select().from(connectors),
      await environment.database.db.select().from(jobs),
    ]);

    expect(persisted).not.toContain(firstValue);
    expect(persisted).not.toContain(secondValue);
    await complete(leased, "succeeded");
    expect(await (await json(path, "GET")).json()).toMatchObject({
      secretRevision: 2,
      appliedSecretRevision: 1,
    });
    const failed = await claim();
    expect((await packages(failed)).connectorSecrets["erp-api"]).toEqual({ API_KEY: secondValue });
    await complete(failed, "failed");
    expect(await (await json(`${path}/secrets`, "GET")).json()).toMatchObject({
      secretRevision: 2,
      appliedSecretRevision: 1,
      state: "failed",
    });
    // Re-uploading previous code retries with the latest desired secrets, never artifact-time values.
    const release = snapshot.connectors.find((connector) => connector.name === "erp-api");

    if (!release) throw new Error("Missing fixture connector");
    await json(path, "PUT", release);
    const retry = await claim();
    expect((await packages(retry)).connectorSecrets["erp-api"]).toEqual({ API_KEY: secondValue });
    await complete(retry, "succeeded");
    await json(secretPath, "DELETE");
    const removal = await claim();
    expect((await packages(removal)).connectorSecrets["erp-api"]).toEqual({});
    await complete(removal, "succeeded");
    expect(await (await json(`${path}/secrets`, "GET")).json()).toMatchObject({
      secrets: [],
      secretRevision: 3,
      appliedSecretRevision: 3,
    });
    expect(JSON.stringify(await (await json("/connectors", "GET")).json())).not.toContain(
      secondValue,
    );
  });
  it("reserves applied Durable Object classes when a replacement deployment fails", async () => {
    const source = "export default { fetch() { return new Response('fixture'); } }";

    const release = contract.connectorPackage.parse({
      protocol: 1,
      name: "class-owner",
      main: "worker.js",
      entrypoints: ["default"],
      modules: [
        { name: "worker.js", source, sha256: createHash("sha256").update(source).digest("hex") },
      ],
      configuration: {
        compatibility_date: "2026-10-01",
        durable_objects: { bindings: [{ name: "STATE", class_name: "SharedSession" }] },
      },
    });

    const finish = async (id: string, outcome: "succeeded" | "failed") => {
      while (true) {
        const job = contract.job
          .nullable()
          .parse(await (await json("/agent/jobs/claim", "POST", {}, agentHeaders)).json());

        if (!job) throw new Error("Expected the connector job to be claimable");
        expect(
          (
            await json(
              `/agent/jobs/${job.id}/complete`,
              "POST",
              {
                leaseToken: job.leaseToken,
                outcome: job.id === id ? outcome : "succeeded",
                message: "Fixture completion",
              },
              agentHeaders,
            )
          ).status,
        ).toBe(200);

        if (job.id === id) return;
      }
    };

    const first = contract.connectorStatus.parse(
      await (await json("/connectors/class-owner", "PUT", release)).json(),
    );

    await finish(first.jobId, "succeeded");

    const replacement = {
      ...release,
      configuration: { ...release.configuration, durable_objects: { bindings: [] } },
    };

    const pending = contract.connectorStatus.parse(
      await (await json("/connectors/class-owner", "PUT", replacement)).json(),
    );

    const contender = { ...release, name: "class-contender" };
    expect((await json("/connectors/class-contender", "PUT", contender)).status).toBe(409);
    await finish(pending.jobId, "failed");
    expect((await json("/connectors/class-contender", "PUT", contender)).status).toBe(409);

    const retry = contract.connectorStatus.parse(
      await (await json("/connectors/class-owner", "PUT", replacement)).json(),
    );

    await finish(retry.jobId, "succeeded");
    expect((await json("/connectors/class-contender", "PUT", contender)).status).toBe(200);
  });
  it("creates named previews below their parent hostname while preserving legacy preview URLs", async () => {
    const parent = await createApp("preview-parent");

    const input = {
      slug: "preview-parent-review",
      displayName: "Review",
      parentId: parent.id,
      previewName: "review",
    };

    const response = await json("/apps", "POST", input);
    expect(response.status).toBe(200);
    const preview = contract.app.parse(await response.json());
    expect(preview).toMatchObject({
      hostname: `review.${parent.hostname}`,
      parentId: parent.id,
      fleetId: parent.fleetId,
    });
    expect(preview.url).toBe(`https://review.${parent.hostname}/`);
    expect(preview.id).not.toBe(parent.id);

    const legacy = await json("/apps", "POST", {
      slug: "legacy-preview",
      displayName: "Legacy",
      parentId: parent.id,
    });

    expect(contract.app.parse(await legacy.json()).hostname).toBe(
      `legacy-preview.${environment.configuration.APP_DOMAIN}`,
    );
    expect((await json("/apps", "POST", { ...input, slug: "other-slug" })).status).toBe(409);
    expect(
      (await json("/apps", "POST", { ...input, slug: "orphan-preview", parentId: null })).status,
    ).toBe(400);
    expect(
      (await json("/apps", "POST", { ...input, slug: "nested-preview", parentId: preview.id }))
        .status,
    ).toBe(400);
    expect(
      (await json("/apps", "POST", { ...input, slug: "invalid-preview", previewName: "a.b" }))
        .status,
    ).toBe(400);
    expect(
      (await json("/apps", "POST", { ...input, slug: "outsider-preview" }, outsiderHeaders)).status,
    ).toBe(404);
  });

  it("keeps the existing SSO policy active when migrating published apps", async () => {
    const migration = await readFile(
      new URL("../migrations/0012_app_access.sql", import.meta.url),
      "utf8",
    );

    const client = new pg.Client({ connectionString: environment.configuration.DATABASE_URL });
    await client.connect();

    try {
      await client.query(
        "CREATE TEMP TABLE app (id integer, active_deployment_id uuid); CREATE TEMP TABLE job (id integer)",
      );
      await client.query("INSERT INTO app VALUES (1, $1), (2, NULL)", [crypto.randomUUID()]);
      await client.query(migration);

      const result = await client.query(
        "SELECT id, access_groups, access_revision, applied_access_revision FROM app ORDER BY id",
      );

      expect(result.rows).toEqual([
        { id: 1, access_groups: [], access_revision: 0, applied_access_revision: 0 },
        { id: 2, access_groups: [], access_revision: 0, applied_access_revision: null },
      ]);
    } finally {
      await client.end();
    }
  });

  it("serializes preview creation with inherited access changes", async () => {
    const parent = await createApp("access-creation-race");

    const [creation, change] = await Promise.all([
      json("/apps", "POST", {
        slug: "access-racing-preview",
        displayName: "Concurrent preview",
        parentId: parent.id,
        previewName: "review",
      }),
      json(`/apps/${parent.id}/access`, "PATCH", {
        groups: ["reviewers"],
        revision: 0,
      }),
    ]);

    expect(creation.status).toBe(200);
    expect(change.status).toBe(200);
    const preview = contract.app.parse(await creation.json());
    expect(await (await json(`/apps/${preview.id}/access`, "GET")).json()).toMatchObject({
      groups: ["reviewers"],
      revision: 1,
      inheritedFrom: parent.id,
    });

    const edits = await Promise.all([
      json(`/apps/${parent.id}/access`, "PATCH", {
        groups: ["finance"],
        revision: 1,
      }),
      json(`/apps/${parent.id}/access`, "PATCH", { groups: ["audit"], revision: 1 }),
    ]);

    expect(edits.map((response) => response.status).sort((left, right) => left - right)).toEqual([
      200, 409,
    ]);
  });

  it("inherits access rules, rejects preview overrides and preserves inherited restrictions until preview cleanup", async () => {
    const app = await createApp("group-access-parent");
    const path = `/apps/${app.id}/access`;
    const initial = contract.appAccessState.parse(await (await json(path, "GET")).json());
    expect(initial).toMatchObject({
      groups: [],
      inheritedFrom: null,
      canManage: true,
      state: "saved",
      revision: 0,
    });
    expect((await json(path, "GET", undefined, outsiderHeaders)).status).toBe(404);
    expect((await json(`/apps/${app.id}/creators/${outsiderId}`, "PUT", {})).status).toBe(200);
    expect(
      (await json(path, "PATCH", { groups: ["finance"], revision: 0 }, outsiderHeaders)).status,
    ).toBe(403);
    expect((await json(path, "PATCH", { groups: ["finance,all"], revision: 0 })).status).toBe(400);
    expect((await json(path, "PATCH", { groups: ["finance"], revision: 0 })).status).toBe(200);
    expect((await json(path, "PATCH", { groups: ["reviewers"], revision: 0 })).status).toBe(409);
    expect((await json(path, "PATCH", { groups: ["reviewers"], revision: 1 })).status).toBe(200);

    const preview = contract.app.parse(
      await (
        await json("/apps", "POST", {
          slug: "group-access-review",
          displayName: "Review",
          parentId: app.id,
          previewName: "review",
        })
      ).json(),
    );

    const previewPath = `/apps/${preview.id}/access`;
    expect(await (await json(previewPath, "GET")).json()).toMatchObject({
      groups: ["reviewers"],
      inheritedFrom: app.id,
      canManage: false,
      revision: 2,
    });
    expect((await json(previewPath, "PATCH", { groups: [], revision: 2 })).status).toBe(403);
    expect((await json(path, "PATCH", { groups: ["qa"], revision: 2 })).status).toBe(200);
    expect(await (await json(previewPath, "GET")).json()).toMatchObject({
      groups: ["qa"],
      revision: 3,
    });
    expect(await (await json(path, "GET")).json()).toMatchObject({
      groups: ["qa"],
      previews: [{ appId: preview.id, groups: ["qa"] }],
    });

    expect((await json(`/apps/${app.id}`, "DELETE")).status).toBe(200);
    expect(await (await json(previewPath, "GET")).json()).toMatchObject({
      groups: ["qa"],
      inheritedFrom: app.id,
      revision: 3,
    });
    expect((await json(previewPath, "PATCH", { groups: [], revision: 3 })).status).toBe(403);

    for (const target of [app, preview]) {
      const token = crypto.randomUUID();

      const [deletion] = await environment.database.db
        .update(jobs)
        .set({
          state: "running",
          agentId,
          leaseToken: token,
          leaseUntil: new Date(Date.now() + 90000),
        })
        .where(sql`${jobs.appId} = ${target.id} and ${jobs.kind} = 'delete'`)
        .returning();

      if (!deletion) throw new Error("Missing deletion job");
      expect(
        (
          await json(
            `/agent/jobs/${deletion.id}/complete`,
            "POST",
            {
              leaseToken: token,
              outcome: "succeeded",
              message: "Fixture removed",
            },
            agentHeaders,
          )
        ).status,
      ).toBe(200);
      expect((await json(`/apps/${target.id}`, "GET")).status).toBe(404);

      if (target.id === app.id) {
        expect(await (await json(previewPath, "GET")).json()).toMatchObject({
          groups: ["qa"],
          inheritedFrom: app.id,
          revision: 3,
        });
        expect((await json(previewPath, "PATCH", { groups: [], revision: 3 })).status).toBe(403);
      }
    }
  });

  it("fences old agents, tracks confirmed revisions and reconciles access edits during first deploy and rollback", async () => {
    // Earlier tests also exercise the queue without running a real agent.
    await environment.database.db.update(jobs).set({ state: "succeeded" });
    const app = await createApp("access-activation");
    const path = `/apps/${app.id}/access`;
    const session = await start(app.id);
    const deployment = contract.deployment.parse(await (await publish(app.id, session.id)).json());

    const claim = async () =>
      contract.job.parse(
        await (await json("/agent/jobs/claim", "POST", { accessRules: 1 }, agentHeaders)).json(),
      );

    const complete = (
      job: z.infer<typeof contract.job>,
      accessRevision: number | undefined,
      outcome: "succeeded" | "failed" = "succeeded",
    ) =>
      json(
        `/agent/jobs/${job.id}/complete`,
        "POST",
        {
          leaseToken: job.leaseToken,
          outcome,
          message: "Synthetic access activation",
          accessRevision,
        },
        agentHeaders,
      );

    const first = await claim();
    expect(first.access).toEqual({ revision: 0, groups: [] });
    expect((await json(path, "PATCH", { groups: ["finance"], revision: 0 })).status).toBe(200);
    expect((await complete(first, 0)).status).toBe(200);
    expect(await (await json(path, "GET")).json()).toMatchObject({
      state: "pending",
      revision: 1,
      appliedRevision: 0,
    });
    expect((await json("/agent/jobs/claim", "POST", {}, agentHeaders)).status).toBe(409);
    const restricted = await claim();
    expect(restricted).toMatchObject({
      kind: "configure",
      deploymentId: deployment.id,
      access: { revision: 1, groups: ["finance"] },
    });
    expect((await complete(restricted, undefined)).status).toBe(409);
    expect((await complete(restricted, 0)).status).toBe(409);
    expect((await complete(restricted, 1)).status).toBe(200);
    expect(await (await json(path, "GET")).json()).toMatchObject({
      state: "active",
      appliedRevision: 1,
    });
    expect((await json(path, "PATCH", { groups: ["operations"], revision: 1 })).status).toBe(200);
    const outdated = await claim();
    expect((await json(path, "PATCH", { groups: ["audit"], revision: 2 })).status).toBe(200);
    expect((await complete(outdated, 2, "failed")).status).toBe(200);
    expect(await (await json(path, "GET")).json()).toMatchObject({
      state: "pending",
      appliedRevision: 1,
      error: null,
    });
    const current = await claim();
    expect(current.access).toEqual({ revision: 3, groups: ["audit"] });
    expect((await complete(current, 3, "failed")).status).toBe(200);
    expect(await (await json(path, "GET")).json()).toMatchObject({
      state: "failed",
      appliedRevision: 1,
    });
    expect((await json(path, "PATCH", { groups: ["audit"], revision: 3 })).status).toBe(200);
    const retry = await claim();
    expect((await complete(retry, 3)).status).toBe(200);
    expect(
      (
        await json(
          `/apps/${app.id}/rollback`,
          "POST",
          { artifactId: deployment.artifactId },
          adminHeaders,
          crypto.randomUUID(),
        )
      ).status,
    ).toBe(200);
    const rollback = await claim();
    expect(rollback).toMatchObject({ kind: "deploy", access: { revision: 3, groups: ["audit"] } });
    expect((await complete(rollback, 3)).status).toBe(200);
    expect((await json(path, "PATCH", { groups: [], revision: 3 })).status).toBe(200);
    const unrestricted = await claim();
    expect(unrestricted.access).toEqual({ revision: 4, groups: [] });
    expect((await complete(unrestricted, 4)).status).toBe(200);
    expect(await (await json(path, "GET")).json()).toMatchObject({
      state: "active",
      groups: [],
      appliedRevision: 4,
    });
  });

  it("exposes catalog discovery without management access and restricts publication to owners or administrators", async () => {
    const app = await createApp("catalog-api");
    const path = `/apps/${app.id}/catalog`;
    expect((await json("/catalog", "GET", undefined, new Headers())).status).toBe(401);
    expect((await json(path, "PUT", { listed: true }, new Headers())).status).toBe(401);
    expect((await json(path, "PUT", { listed: true })).status).toBe(409);
    await environment.database.db
      .update(apps)
      .set({
        state: "active",
        activeDeploymentId: crypto.randomUUID(),
      })
      .where(eq(apps.id, app.id));
    expect(await (await json("/catalog", "GET", undefined, outsiderHeaders)).json()).toEqual([]);
    expect((await json(path, "PUT", { listed: true }, outsiderHeaders)).status).toBe(404);
    expect((await json(path, "PUT", { listed: "true" })).status).toBe(400);
    expect(await (await json(path, "PUT", { listed: true })).json()).toEqual({ listed: true });
    expect(
      z
        .array(contract.catalogEntry)
        .parse(await (await json("/catalog", "GET", undefined, outsiderHeaders)).json()),
    ).toEqual([
      contract.catalogEntry.parse({
        id: app.id,
        displayName: app.displayName,
        hostname: app.hostname,
        url: app.url,
      }),
    ]);
    expect((await json(`/apps/${app.id}`, "GET", undefined, outsiderHeaders)).status).toBe(404);
    expect(await (await json(`/apps/${app.id}/creators/${outsiderId}`, "PUT", {})).json()).toEqual({
      granted: true,
    });
    expect((await json(path, "PUT", { listed: false }, outsiderHeaders)).status).toBe(403);
    expect(await (await json(path, "PUT", { listed: false })).json()).toEqual({ listed: false });
    expect(await (await json("/catalog", "GET", undefined, outsiderHeaders)).json()).toEqual([]);
  });
});
