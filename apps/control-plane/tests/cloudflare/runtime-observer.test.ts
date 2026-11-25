import { describe, expect, it } from "vitest";
import { build } from "esbuild";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { z } from "zod";

const observation = z.object({
  identity: z.json(),
  label: z.string(),
  events: z.array(z.object({ outcome: z.string(), cpuTime: z.number(), wallTime: z.number() })),
});

const keyValueObservation = z.strictObject({
  identity: z.json(),
  event: z.strictObject({
    timestamp: z.number(),
    binding: z.literal("APP_KV"),
    operation: z.enum(["read", "write", "delete", "list"]),
    count: z.number(),
    outcome: z.enum(["ok", "error"]),
  }),
});

const exception = z.object({
  event: z.literal("$exception"),
  distinct_id: z.string(),
  properties: z.object({
    scope: z.string(),
    service: z.literal("app-runtime"),
    operation: z.string(),
    app_id: z.string().optional(),
    deployment_id: z.string().optional(),
    build_id: z.string().nullable().optional(),
    $groups: z.object({ organization: z.string() }).optional(),
    $process_person_profile: z.literal(false),
    $exception_list: z.array(z.object({ type: z.string(), value: z.string() })),
  }),
});

const appUser = z.object({
  event: z.literal("app_user_active"),
  distinct_id: z.string(),
  properties: z.object({
    scope: z.string(),
    service: z.literal("app-runtime"),
    trigger: z.string(),
    app_id: z.string().optional(),
    $groups: z.object({ organization: z.string() }),
    $set: z.object({ name: z.string(), email: z.string() }),
  }),
});

const logBatch = z.object({
  resourceLogs: z.array(
    z.object({
      scopeLogs: z.array(
        z.object({
          logRecords: z.array(z.object({ body: z.object({ stringValue: z.string() }) })),
        }),
      ),
    }),
  ),
});

describe.runIf(process.env["RUN_CLOUDFLARE_TESTS"] === "1")("Runtime observer in workerd", () => {
  it("delivers trusted app and service identities alongside logs, with parent-only bindings", async () => {
    const directory = await mkdtemp(join(tmpdir(), "widefleet-observer-"));
    const observations: z.infer<typeof observation>[] = [];
    const logs: z.infer<ReturnType<typeof z.json>>[] = [];
    const errors: Error[] = [];
    const keyValues: z.infer<typeof keyValueObservation>[] = [];
    const pending: ServerResponse[] = [];
    const exceptions: z.infer<typeof exception>[] = [];
    const appUsers: z.infer<typeof appUser>[] = [];
    let exceptionStatus = 503;

    const collector = createServer((request, response) => {
      const handle = async () => {
        const chunks: Uint8Array[] = [];

        for await (const chunk of request) chunks.push(z.instanceof(Uint8Array).parse(chunk));
        const bytes = Buffer.concat(chunks);

        const body = z
          .json()
          .parse(
            JSON.parse(
              (request.headers["content-encoding"] === "gzip"
                ? gunzipSync(bytes)
                : bytes
              ).toString(),
            ),
          );

        if (request.url === "/exception") {
          for (const event of z
            .object({ batch: z.array(z.union([exception, appUser])) })
            .parse(body).batch)
            if (event.event === "app_user_active") appUsers.push(event);
            else exceptions.push(event);
          // Reporting failure must not change the platform failure or fallback response.
          response.writeHead(exceptionStatus).end("{}");

          return;
        } else if (request.url === "/key-value") {
          keyValues.push(keyValueObservation.parse(body));
          pending.push(response);

          return;
        } else if (request.url === "/observer") observations.push(observation.parse(body));
        else {
          expect(request.url).toBe("/v1/logs");
          expect(request.headers.authorization).toBe("Bearer synthetic-log-token");

          for (const resource of logBatch.parse(body).resourceLogs)
            for (const scope of resource.scopeLogs)
              for (const record of scope.logRecords)
                logs.push(z.json().parse(JSON.parse(record.body.stringValue)));
        }

        response.writeHead(204).end();
      };

      void handle().catch((error: Error) => {
        errors.push(error);
        response.writeHead(500).end();
      });
    });

    let worker: Awaited<ReturnType<typeof import("wrangler").unstable_dev>> | undefined;

    try {
      collector.listen(0, "127.0.0.1");
      await once(collector, "listening");
      const { port } = z.object({ port: z.number() }).parse(collector.address());
      const runtime = import.meta.resolve("@platform/app-runtime/runtime-extension");
      const main = join(directory, "index.js");
      const extension = fileURLToPath(new URL("../fixtures/observer-extension.ts", runtime));

      const child = async (entry: string) => {
        const result = await build({
          entryPoints: [fileURLToPath(new URL(`${entry}.ts`, runtime))],
          bundle: true,
          format: "esm",
          platform: "browser",
          conditions: ["workerd"],
          external: ["cloudflare:*", "node:*", "./__widefleet_app.js", "./__widefleet_bindings.js"],
          // Even when aliased, the child import graph must not reach the extension.
          alias: {
            "#runtime-extension": extension,
            "widefleet:app": "./__widefleet_app.js",
            "widefleet:bindings": "./__widefleet_bindings.js",
          },
          write: false,
        });

        return z.string().parse(result.outputFiles[0]?.text);
      };

      const bindingsSource = await child("bindings");
      const fixture = join(directory, "fixture.ts");
      await writeFile(
        fixture,
        `
        export * from ${JSON.stringify(fileURLToPath(new URL("../fixtures/observer.ts", runtime)))};
        export { default } from ${JSON.stringify(fileURLToPath(new URL("../fixtures/observer.ts", runtime)))};
        const originalFetch = globalThis.fetch;
        globalThis.fetch = (input, options) => {
          const request = new Request(input, options);
          return originalFetch(new URL(request.url).origin === 'https://eu.i.posthog.com'
            ? new Request('http://127.0.0.1:${port}/exception', request) : request);
        };
      `,
      );
      await build({
        entryPoints: [fixture],
        outfile: main,
        bundle: true,
        format: "esm",
        platform: "browser",
        conditions: ["workerd"],
        external: ["cloudflare:*", "node:*"],
        alias: { "#runtime-extension": extension },
        define: {
          WIDEFLEET_BINDINGS_SOURCE: JSON.stringify(bindingsSource),
          WIDEFLEET_EVENTS_SOURCE: JSON.stringify(await child("events")),
          WIDEFLEET_WORKFLOW_SOURCE: JSON.stringify(""),
        },
      });
      const config = join(directory, "wrangler.json");
      await writeFile(
        config,
        JSON.stringify({
          name: "runtime-observer-test",
          main,
          compatibility_date: "2026-10-01",
          compatibility_flags: ["nodejs_compat"],
          worker_loaders: [{ binding: "WIDEFLEET_LOADER" }],
          kv_namespaces: [{ binding: "OBSERVER_KV", id: "observer-kv-fixture" }],
          r2_buckets: [{ binding: "WIDEFLEET_PACKAGES", bucket_name: "observer-packages" }],
          vars: {
            OBSERVER_ORIGIN: `http://127.0.0.1:${port}`,
            OBSERVER_LABEL: "parent-only-fixture",
            POSTHOG_PROJECT_TOKEN: "phc_synthetic_fixture",
            POSTHOG_SCOPE: "fixture",
          },
        }),
      );
      const { unstable_dev } = await import("wrangler");
      worker = await unstable_dev(main, {
        config,
        local: true,
        persist: false,
        ip: "127.0.0.1",
        port: 0,
        inspectorPort: 0,
        logLevel: "error",
        experimental: { disableExperimentalWarning: true, disableDevRegistry: true, watch: false },
      });

      for (const path of ["/app", "/service"]) {
        const response = await worker.fetch(`http://fixture${path}`);
        expect(response.status, await response.clone().text()).toBe(200);
        expect(await response.json()).toEqual([]);
      }

      await expect.poll(() => observations.length, { timeout: 8_000 }).toBe(2);
      await expect.poll(() => logs.length, { timeout: 8_000 }).toBe(2);
      expect(errors).toEqual([]);

      for (const { events } of observations)
        for (const event of events) {
          expect(event.cpuTime).toBeGreaterThanOrEqual(0);
          expect(event.wallTime).toBeGreaterThanOrEqual(0);
        }

      expect(
        observations.map(({ identity, label, events }) => ({
          identity,
          label,
          outcomes: events.map((event) => event.outcome),
        })),
      ).toEqual(
        expect.arrayContaining([
          {
            identity: {
              appId: "a0000000-0000-4000-8000-000000000001",
              deploymentId: "a0000000-0000-4000-8000-000000000002",
              buildId: null,
            },
            label: "parent-only-fixture",
            outcomes: ["ok"],
          },
          {
            identity: {
              organizationId: "observer-fixture",
              appId: "a0000000-0000-4000-8000-000000000004",
              buildId: null,
              deploymentId: "a0000000-0000-4000-8000-000000000003",
            },
            label: "parent-only-fixture",
            outcomes: ["ok"],
          },
        ]),
      );
      expect(logs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            message: "observer fixture log",
            deploymentId: "a0000000-0000-4000-8000-000000000002",
          }),
          expect.objectContaining({
            message: "observer fixture log",
            deploymentId: "a0000000-0000-4000-8000-000000000003",
          }),
        ]),
      );

      // Keep observation delivery pending until all KV calls have returned.
      for (const path of ["/app/kv", "/service/kv"]) {
        const response = await worker.fetch(`http://fixture${path}`);
        expect(response.status, await response.clone().text()).toBe(200);
        expect(await response.json()).toEqual({
          written: 204,
          value: "secret-value",
          missing: 404,
          many: [
            ["secret-key", "secret-value"],
            ["absent-key", null],
          ],
          listed: 1,
          empty: 0,
          failedWrite: 400,
          failedRead: 400,
          failedBulk: true,
          failedDelete: true,
          bindings: ["STORE"],
        });
      }

      await expect.poll(() => keyValues.length, { timeout: 8_000 }).toBe(24);

      for (const identity of [observations[0]?.identity, observations[1]?.identity]) {
        const events = keyValues.flatMap((item) =>
          JSON.stringify(item.identity) === JSON.stringify(identity) ? [item.event] : [],
        );

        expect(events).toHaveLength(12);
        expect(
          events.map(({ operation, count, outcome }) => ({ operation, count, outcome })),
        ).toEqual(
          expect.arrayContaining([
            { operation: "read", count: 3, outcome: "ok" },
            { operation: "write", count: 1, outcome: "ok" },
            { operation: "write", count: 1, outcome: "error" },
            { operation: "delete", count: 1, outcome: "error" },
          ]),
        );
        expect(
          events.filter((event) => event.operation === "read" && event.outcome === "ok"),
        ).toHaveLength(3);
        expect(events.filter((event) => event.outcome === "error")).toHaveLength(4);
      }

      expect(JSON.stringify(keyValues)).not.toMatch(
        /secret-key|secret-value|secret-metadata|absent-key/,
      );

      for (const path of ["/app/production-kv", "/service/production-kv"]) {
        const response = await worker.fetch(`http://fixture${path}`);
        expect(response.status, await response.clone().text()).toBe(200);
        expect(await response.json()).toEqual({ value: null, observerBindingVisible: false });
      }

      await expect.poll(() => keyValues.length, { timeout: 8_000 }).toBe(26);
      expect(
        keyValues.slice(24).map(({ identity, event: { timestamp, ...event } }) => {
          expect(timestamp).toBeGreaterThan(0);

          return { identity, event };
        }),
      ).toEqual(
        expect.arrayContaining(
          observations.slice(0, 2).map(({ identity }) => ({
            identity,
            event: {
              binding: "APP_KV",
              operation: "read",
              count: 1,
              outcome: "ok",
            },
          })),
        ),
      );
      expect(bindingsSource).not.toContain("OBSERVER_LABEL");
      expect(bindingsSource).not.toContain("POSTHOG_PROJECT_TOKEN");

      // A rejected observer request must not change the already successful KV results.
      for (const response of pending) response.writeHead(503).end();
      pending.length = 0;
      expect(errors).toEqual([]);

      const preparation = await worker.fetch("http://fixture/platform-error/preparation");
      expect(preparation.status).toBe(500);
      expect(await preparation.text()).toBe("Worker resource is not installed");
      expect((await worker.fetch("http://fixture/platform-error/catalog")).status).toBe(500);
      expect((await worker.fetch("http://fixture/platform-error/availability")).status).toBe(503);
      await expect.poll(() => exceptions.length, { timeout: 8_000 }).toBe(3);
      expect(
        exceptions.find(({ properties }) => properties.operation === "prepare_worker"),
      ).toMatchObject({
        event: "$exception",
        distinct_id: "fixture:app-runtime",
        properties: {
          scope: "fixture",
          service: "app-runtime",
          $process_person_profile: false,
          $exception_list: [{ type: "Error", value: "Worker resource is not installed" }],
          operation: "prepare_worker",
          $groups: { organization: "observer-fixture" },
          app_id: "a0000000-0000-4000-8000-000000000004",
          deployment_id: "a0000000-0000-4000-8000-000000000003",
          build_id: null,
        },
      });

      const catalogException = exceptions.find(
        ({ properties }) => properties.operation === "read_app",
      );

      expect(catalogException).toBeDefined();
      expect(catalogException?.properties.app_id).toBeUndefined();
      expect(catalogException?.properties.$groups).toBeUndefined();
      expect(
        exceptions.find(({ properties }) => properties.operation === "read_availability")
          ?.properties,
      ).toMatchObject({
        operation: "read_availability",
        $groups: { organization: "observer-fixture" },
      });
      expect((await worker.fetch("http://fixture/platform-error/catalog-context")).status).toBe(
        500,
      );
      await expect.poll(() => exceptions.length, { timeout: 8_000 }).toBe(4);
      expect(
        exceptions.find(
          ({ properties }) => properties.operation === "read_app" && properties.app_id,
        )?.properties,
      ).toMatchObject({
        operation: "read_app",
        app_id: "a0000000-0000-4000-8000-000000000004",
        $groups: { organization: "observer-fixture" },
      });
      expect(
        (await worker.fetch("http://fixture/platform-error/catalog?unconfigured")).status,
      ).toBe(500);
      expect((await worker.fetch("http://fixture/customer-error")).status).toBe(500);
      expect(exceptions).toHaveLength(4);
      exceptionStatus = 200;
      expect(
        (await worker.fetch("http://fixture/platform-error/preparation?default-scope")).status,
      ).toBe(500);
      await expect.poll(() => exceptions.length, { timeout: 8_000 }).toBe(5);
      expect(
        exceptions.find(({ properties }) => properties.scope === "installation")?.distinct_id,
      ).toBe("installation:app-runtime");

      expect((await worker.fetch("http://fixture/app-user?unconfigured")).status).toBe(204);
      expect((await worker.fetch("http://fixture/app-user")).status).toBe(204);
      await expect.poll(() => appUsers.length, { timeout: 8_000 }).toBe(1);
      expect(appUsers[0]?.distinct_id).toMatch(/^app-user:[a-f0-9]{64}$/);
      expect(appUsers[0]?.properties).toMatchObject({
        scope: "fixture",
        service: "app-runtime",
        trigger: "renewal",
        app_id: "a0000000-0000-4000-8000-000000000001",
        $groups: { organization: "observer-fixture" },
        $set: { name: "Example User", email: "user@example.test" },
      });
      expect(appUsers[0]?.distinct_id).not.toContain("subject-1");
      expect(errors).toEqual([]);
    } finally {
      for (const response of pending) response.writeHead(503).end();
      await worker?.stop();
      await new Promise<void>((resolve, reject) =>
        collector.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(directory, { recursive: true, force: true });
    }
  }, 25_000);
});
