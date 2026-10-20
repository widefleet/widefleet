import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import * as contract from "@platform/contracts";
import { createTestEnvironment } from "./environment.ts";
import {
  connectorFixture,
  connectorSource,
  connectorFiles,
  connectorUploadForm,
} from "./cloudflare-connector.fixture.ts";
import { member, organization } from "../src/lib/server/auth-schema.ts";
import {
  apps,
  connectors,
  fleets,
  jobs,
  cloudflareOperations,
  agents,
} from "../src/lib/server/schema.ts";
import { createArtifactStorage } from "../src/lib/server/artifact-storage.ts";
import { createRuntime } from "../src/lib/server/runtime-services.ts";
import { createApi } from "../src/lib/server/api.ts";
import { createJobService } from "../src/lib/server/jobs.ts";
import { createDatabase } from "../src/lib/server/database.ts";
import { createTelemetry } from "../src/lib/server/telemetry.ts";
import { connectorReference, saveConnector } from "../src/lib/server/connector-package.ts";
import { connectorCommand } from "../src/lib/server/cloudflare-connector-command.ts";
import { registerCloudflareConnector } from "../src/lib/server/cloudflare-connectors.ts";
import { decryptSecret } from "../src/lib/server/secret-encryption.ts";

describe("Organization connector management", () => {
  let environment: Awaited<ReturnType<typeof createTestEnvironment>>;
  let runtime: Awaited<ReturnType<ReturnType<typeof createRuntime>>>;
  const objects = new Map<string, Uint8Array>();

  const storage = createArtifactStorage({
    put: async (key, bytes) => {
      objects.set(key, bytes);
    },
    get: async (key) => {
      const bytes = objects.get(key);

      if (!bytes) throw new Error("Missing fixture artifact");

      return bytes;
    },
    exists: async (key) => objects.has(key),
    async *list(prefix) {
      for (const [key, bytes] of objects)
        if (key.startsWith(prefix)) yield { key, size: bytes.length };
    },
    remove: async (keys) => {
      for (const key of keys) objects.delete(key);
    },
  });

  beforeAll(async () => {
    environment = await createTestEnvironment();
    runtime = await createRuntime({
      configuration: environment.configuration,
      database: environment.database,
      settings: environment.settings,
      reporting: environment.reporting,
      storage,
      encryptionKey: environment.environment.PLATFORM_ENCRYPTION_KEY,
      fleetAccess: {
        filterFleets: async (candidates) => candidates.map((candidate) => candidate.id),
      },
    })();
  });
  afterAll(async () => {
    await environment.close();
  });

  const scope = async (executor: "agent" | "cloudflare" = "agent") => {
    const id = crypto.randomUUID();
    const fleetId = crypto.randomUUID();
    await environment.database.db.insert(organization).values({
      id,
      name: id,
      slug: id,
      createdAt: new Date(),
    });
    await environment.database.db.insert(fleets).values({
      id: fleetId,
      name: id,
      organizationId: id,
      appDomain: `${id}.example.test`,
      executor,
    });

    const user = environment.users.createUser({
      name: "Connector administrator",
      email: `${id}@example.test`,
    });

    await environment.users.saveUser(user);
    await environment.database.db.insert(member).values({
      id: crypto.randomUUID(),
      userId: user.id,
      organizationId: id,
      role: "admin",
      createdAt: new Date(),
    });
    const headers = new Headers((await environment.users.login({ userId: user.id })).headers);
    headers.set("origin", environment.configuration.PLATFORM_URL);
    headers.set("x-widefleet-organization", id);

    const principal = (
      await runtime.identity.authenticate(
        new Request(environment.configuration.PLATFORM_URL, { headers }),
        "platform:write",
      )
    ).unwrap();

    expect(principal).toMatchObject({
      admin: false,
      application: { admin: true, fleetId, organizationId: id },
    });
    const api = createApi(runtime);

    const request = (path: string, method = "GET", body?: FormData | string) => {
      const selected = new Headers(headers);
      selected.set("idempotency-key", "11111111-1111-4111-8111-111111111111");

      if (body !== undefined && !(body instanceof FormData))
        selected.set("content-type", "application/json");

      const options: RequestInit = { method, headers: selected };

      if (body !== undefined) options.body = body;

      return api(new Request(`${environment.configuration.PLATFORM_URL}/api/v1${path}`, options));
    };

    return { principal, request, fleetId };
  };

  it("creates and updates same-named connectors and secrets only in the selected organization", async () => {
    const first = await scope();
    const second = await scope();
    const release = connectorFixture("shared");

    const publish = async (target: typeof first) => {
      const response = await target.request(
        "/connectors/shared",
        "PUT",
        connectorUploadForm(release),
      );

      expect(response.status).toBe(200);

      return contract.connectorStatus.parse(await response.json());
    };

    const a = await publish(first);
    const b = await publish(second);
    expect(a.jobId).not.toBe(b.jobId);
    expect(a.checksum).not.toBe(b.checksum);
    expect((await publish(first)).jobId).toBe(a.jobId);

    for (const [target, value] of [
      [first, "first-secret"],
      [second, "second-secret"],
    ] as const) {
      expect(
        (
          await target.request(
            "/connectors/shared/secrets/API_KEY",
            "PUT",
            JSON.stringify({ value }),
          )
        ).status,
      ).toBe(200);

      const listing = contract.connectorStatus
        .array()
        .parse(await (await target.request("/connectors")).json());

      expect(listing).toHaveLength(1);
      expect(listing[0]).toMatchObject({ name: "shared", secrets: ["API_KEY"], secretRevision: 1 });

      const [record] = await environment.database.db
        .select()
        .from(connectors)
        .where(eq(connectors.fleetId, target.fleetId));

      const reference = connectorReference.parse(record?.package);
      expect(
        await decryptSecret(
          environment.environment.PLATFORM_ENCRYPTION_KEY,
          reference.secrets["API_KEY"] ?? "",
        ),
      ).toBe(value);
      expect(
        (
          await environment.database.db
            .select()
            .from(jobs)
            .where(eq(jobs.id, listing[0]?.jobId ?? ""))
        )[0]?.fleetId,
      ).toBe(target.fleetId);
    }

    const updated = connectorFixture("shared", `${connectorSource}\n// updated`);

    const changed = (
      await runtime.connectors.deploy(
        first.principal,
        updated,
        connectorFiles(updated),
        crypto.randomUUID(),
      )
    ).unwrap();

    expect(changed.checksum).not.toBe(a.checksum);
    expect(changed.secrets).toEqual(["API_KEY"]);
    expect((await runtime.connectors.read(second.principal, "shared")).unwrap().checksum).toBe(
      b.checksum,
    );
    expect((await first.request("/connectors/shared/secrets/API_KEY", "DELETE")).status).toBe(200);
    expect((await runtime.connectors.read(second.principal, "shared")).unwrap().secrets).toEqual([
      "API_KEY",
    ]);
    const privateRelease = connectorFixture("only-second");
    (
      await runtime.connectors.deploy(
        second.principal,
        privateRelease,
        connectorFiles(privateRelease),
        crypto.randomUUID(),
      )
    ).unwrap();
    expect((await first.request("/connectors/only-second")).status).toBe(404);
    expect((await first.request("/connectors/only-second/secrets/API_KEY", "DELETE")).status).toBe(
      404,
    );

    for (const path of ["/runtime", "/settings", "/reporting"])
      expect((await first.request(path)).status).toBe(403);
    const background = createDatabase(environment.configuration);

    try {
      const worker = createJobService(
        background.db,
        storage,
        environment.environment.PLATFORM_ENCRYPTION_KEY,
      );

      for (const [target, published] of [
        [first, a],
        [second, b],
      ] as const) {
        const agentId = crypto.randomUUID();
        await environment.database.db.insert(agents).values({
          id: agentId,
          fleetId: target.fleetId,
          name: "Scoped fixture agent",
          tokenHash: crypto.randomUUID(),
        });
        const job = (await worker.claim(agentId)).unwrap();
        expect(job).toMatchObject({
          id: published.jobId,
          fleetId: target.fleetId,
          kind: "connector",
        });
      }
    } finally {
      await background.close();
    }
  });

  it("restricts bindings to local apps and denies members even when they own an app", async () => {
    const first = await scope();
    const second = await scope();
    const release = connectorFixture("erp");

    for (const target of [first, second])
      (
        await runtime.connectors.deploy(
          target.principal,
          release,
          connectorFiles(release),
          crypto.randomUUID(),
        )
      ).unwrap();

    const records = await environment.database.db
      .select()
      .from(connectors)
      .where(eq(connectors.name, "erp"));

    for (const record of records)
      await environment.database.db
        .update(connectors)
        .set({ appliedPackage: record.package })
        .where(and(eq(connectors.fleetId, record.fleetId), eq(connectors.name, record.name)));

    const makeApp = async (target: typeof first) =>
      (
        await runtime.apps.create(target.principal, {
          slug: "notes",
          displayName: "Notes",
          parentId: null,
        })
      ).unwrap();

    const a = await makeApp(first);
    const b = await makeApp(second);
    const grant = { connector: "erp", entrypoint: "Reader" };
    expect(
      (await runtime.connectors.bind(first.principal, a.id, "ERP", grant)).unwrap().grants,
    ).toEqual({ ERP: grant });
    expect(await runtime.connectors.bind(first.principal, b.id, "ERP", grant)).toMatchObject({
      error: { code: "NOT_FOUND" },
    });
    expect(
      await runtime.connectors.bind({ ...first.principal, admin: true }, b.id, "ERP", null),
    ).toMatchObject({ error: { code: "NOT_FOUND" } });
    expect((await runtime.connectors.bindings(second.principal, b.id)).unwrap().grants).toEqual({});

    const ordinary = {
      ...first.principal,
      application: { ...first.principal.application, admin: false },
    };

    for (const result of await Promise.all([
      runtime.connectors.list(ordinary),
      runtime.connectors.read(ordinary, "erp"),
      runtime.connectors.deploy(ordinary, release, connectorFiles(release), crypto.randomUUID()),
      runtime.connectors.setSecret(ordinary, "erp", "API_KEY", "denied"),
      runtime.connectors.bind(ordinary, a.id, "ERP", null),
    ]))
      expect(result).toMatchObject({ error: { code: "FORBIDDEN" } });
    await environment.database.db
      .update(member)
      .set({ role: "member" })
      .where(eq(member.userId, first.principal.id));
    expect(
      (await first.request("/connectors/erp", "PUT", connectorUploadForm(release))).status,
    ).toBe(403);
    expect(
      (
        await first.request(
          "/connectors/erp/secrets/API_KEY",
          "PUT",
          JSON.stringify({ value: "denied" }),
        )
      ).status,
    ).toBe(403);
    expect((await first.request("/connector-catalog")).status).toBe(200);
  });

  it("uses the selected fleet for logs and rejects an explicitly foreign log target before querying storage", async () => {
    const first = await scope();
    const second = await scope();
    const release = connectorFixture("logs");

    for (const target of [first, second])
      (
        await runtime.connectors.deploy(
          target.principal,
          release,
          connectorFiles(release),
          crypto.randomUUID(),
        )
      ).unwrap();
    const seen: string[] = [];

    const telemetry = createTelemetry(
      environment.database.db,
      storage,
      environment.configuration,
      async (input) => {
        if (!("fleetId" in input)) throw new Error("Expected connector logs");
        seen.push(input.fleetId);

        return { entries: [], offset: undefined };
      },
    );

    const input = contract.connectorLogQuery.parse({ name: "logs" });
    (await telemetry.queryConnector(first.principal, input)).unwrap();
    expect(seen).toEqual([first.fleetId]);
    expect(
      await telemetry.query(first.principal, { ...input, fleetId: second.fleetId }),
    ).toMatchObject({ error: { code: "NOT_FOUND" } });
    expect(
      await telemetry.queryConnector(
        { ...first.principal, application: { ...first.principal.application, admin: false } },
        input,
      ),
    ).toMatchObject({ error: { code: "FORBIDDEN" } });
    expect(seen).toEqual([first.fleetId]);
  });

  it("validates organization, fleet and admin scope again when a Workflow opens a fresh database connection", async () => {
    const first = await scope("cloudflare");
    const second = await scope("cloudflare");
    const release = connectorFixture("background");
    const checksum = await saveConnector(storage, first.fleetId, release, connectorFiles(release));

    const command = connectorCommand.parse({
      kind: "connector",
      id: crypto.randomUUID(),
      fleetId: first.fleetId,
      actor: first.principal,
      createdAt: new Date().toISOString(),
      change: { kind: "deploy", name: release.name, checksum },
    });

    const background = createDatabase(environment.configuration);

    try {
      for (const forged of [
        { ...command, fleetId: second.fleetId },
        {
          ...command,
          actor: {
            ...first.principal,
            application: {
              ...first.principal.application,
              organizationId: second.principal.application.organizationId,
            },
          },
        },
        {
          ...command,
          actor: {
            ...first.principal,
            admin: true,
            application: { ...first.principal.application, admin: false },
          },
        },
      ])
        expect((await registerCloudflareConnector(background.db, storage, forged)).isErr()).toBe(
          true,
        );
      expect(
        await background.db
          .select()
          .from(cloudflareOperations)
          .where(eq(cloudflareOperations.id, command.id)),
      ).toEqual([]);

      const accepted = (
        await registerCloudflareConnector(background.db, storage, command)
      ).unwrap();

      expect(accepted.fleetId).toBe(first.fleetId);
      expect((await registerCloudflareConnector(background.db, storage, command)).unwrap().id).toBe(
        accepted.id,
      );
      expect(
        await background.db.select().from(connectors).where(eq(connectors.fleetId, second.fleetId)),
      ).toEqual([]);
      expect(
        await background.db.select().from(apps).where(eq(apps.fleetId, second.fleetId)),
      ).toEqual([]);
    } finally {
      await background.close();
    }
  });
  it.runIf(process.env["RUN_CLI_TESTS"] === "1")(
    "runs connector administration through the real CLI and shared authenticated API",
    async () => {
      const first = await scope();
      const second = await scope();
      await environment.database.db.insert(member).values({
        id: crypto.randomUUID(),
        userId: first.principal.id,
        organizationId: second.principal.application.organizationId,
        role: "admin",
        createdAt: new Date(),
      });
      const release = connectorFixture("shared-cli");
      const appIds = [];

      for (const target of [first, second]) {
        (
          await runtime.connectors.deploy(
            target.principal,
            release,
            connectorFiles(release),
            crypto.randomUUID(),
          )
        ).unwrap();

        const [record] = await environment.database.db
          .select()
          .from(connectors)
          .where(and(eq(connectors.fleetId, target.fleetId), eq(connectors.name, release.name)));

        if (!record) throw new Error("Missing CLI connector");
        await environment.database.db
          .update(connectors)
          .set({ appliedPackage: record.package })
          .where(and(eq(connectors.fleetId, target.fleetId), eq(connectors.name, release.name)));
        appIds.push(
          (
            await runtime.apps.create(target.principal, {
              slug: "cli-notes",
              displayName: "CLI notes",
              parentId: null,
            })
          ).unwrap().id,
        );
      }

      const now = Math.floor(Date.now() / 1000);

      const { token } = await runtime.auth.api.signJWT({
        body: {
          payload: {
            sub: first.principal.id,
            aud: `${environment.configuration.PLATFORM_URL}/api/v1`,
            iss: `${environment.configuration.PLATFORM_URL}/api/auth`,
            iat: now,
            exp: now + 300,
            scope: "platform:read platform:write",
          },
        },
      });

      const api = createApi(runtime);

      const server = createServer((incoming, outgoing) => {
        const handle = async () => {
          const headers = new Headers();

          for (const [key, value] of Object.entries(incoming.headers))
            if (value !== undefined)
              headers.set(key, Array.isArray(value) ? value.join(", ") : value);
          const chunks: Uint8Array[] = [];

          for await (const chunk of incoming) chunks.push(z.instanceof(Uint8Array).parse(chunk));

          const response = await api(
            new Request(`${environment.configuration.PLATFORM_URL}${incoming.url ?? "/"}`, {
              method: incoming.method ?? "GET",
              headers,
              body: chunks.length ? Buffer.concat(chunks) : null,
            }),
          );

          outgoing.writeHead(response.status, Object.fromEntries(response.headers));
          outgoing.end(Buffer.from(await response.arrayBuffer()));
        };

        void handle().catch(() => outgoing.writeHead(500).end());
      });

      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = z.object({ port: z.number() }).parse(server.address());
      const directory = await mkdtemp(join(tmpdir(), "widefleet-scoped-cli-"));
      const file = join(directory, "secret.txt");

      const binary =
        process.env["CLI_BINARY"] ??
        fileURLToPath(
          new URL(
            `../../../target/debug/${process.platform === "win32" ? "widefleet.exe" : "widefleet"}`,
            import.meta.url,
          ),
        );

      const execute = promisify(execFile);

      const cli = (organizationId: string, ...args: string[]) =>
        execute(binary, ["--organization", organizationId, "connector", "--json", ...args], {
          cwd: directory,
          timeout: 10000,
          env: {
            ...process.env,
            PLATFORM_URL: `http://127.0.0.1:${address.port}`,
            PLATFORM_ACCESS_TOKEN: token,
            PLATFORM_USAGE_REPORTING: "false",
            PLATFORM_CRASH_REPORTING: "false",
          },
        });

      try {
        for (const target of [first, second]) {
          const id = target.principal.application.organizationId;
          const list = await cli(id, "list");
          expect(
            contract.connectorStatus
              .array()
              .parse(JSON.parse(list.stdout))
              .map((item) => item.name),
          ).toEqual([release.name]);
          await writeFile(file, id);
          await cli(id, "secret", "put", release.name, "API_KEY", "--file", file, "--no-wait");
          const names = await cli(id, "secret", "list", release.name);
          expect(JSON.parse(names.stdout)).toMatchObject({ secrets: ["API_KEY"] });
          await cli(
            id,
            "bind",
            release.name,
            "--as",
            "ERP",
            "--app",
            "cli-notes",
            "--entrypoint",
            "Reader",
            "--no-wait",
          );
          const bindings = await cli(id, "bindings", "--app", "cli-notes");
          expect(JSON.parse(bindings.stdout)).toMatchObject({
            grants: { ERP: { connector: release.name, entrypoint: "Reader" } },
          });
        }

        await cli(
          first.principal.application.organizationId,
          "unbind",
          "ERP",
          "--app",
          "cli-notes",
          "--no-wait",
        );
        expect(
          (await runtime.connectors.bindings(second.principal, appIds[1] ?? "")).unwrap().grants,
        ).toHaveProperty("ERP");
        await expect(cli("unknown", "list")).rejects.toMatchObject({ code: 1, stdout: "" });
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
