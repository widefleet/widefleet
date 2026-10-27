import { describe, expect, it } from "vitest";
import { build } from "esbuild";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
  it("delivers trusted app and connector identities alongside logs, with parent-only bindings", async () => {
    const directory = await mkdtemp(join(tmpdir(), "widefleet-observer-"));
    const observations: z.infer<typeof observation>[] = [];
    const logs: z.infer<ReturnType<typeof z.json>>[] = [];
    const errors: Error[] = [];
    const keyValues: z.infer<typeof keyValueObservation>[] = [];
    const pending: ServerResponse[] = [];

    const collector = createServer((request, response) => {
      const handle = async () => {
        const chunks: Uint8Array[] = [];

        for await (const chunk of request) chunks.push(z.instanceof(Uint8Array).parse(chunk));
        const body = z.json().parse(JSON.parse(Buffer.concat(chunks).toString()));

        if (request.url === "/key-value") {
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
          external: ["cloudflare:*", "node:*", "./__widefleet_app.js"],
          // Even when aliased, the child import graph must not reach the extension.
          alias: { "#runtime-extension": extension, "widefleet:app": "./__widefleet_app.js" },
          write: false,
        });

        return z.string().parse(result.outputFiles[0]?.text);
      };

      const bindingsSource = await child("bindings");
      await build({
        entryPoints: [fileURLToPath(new URL("../fixtures/observer.ts", runtime))],
        outfile: main,
        bundle: true,
        format: "esm",
        platform: "browser",
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

      for (const path of ["/app", "/connector"]) {
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
              connector: "fixture",
              connectorVersion: "a0000000-0000-4000-8000-000000000003",
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
            connectorVersion: "a0000000-0000-4000-8000-000000000003",
          }),
        ]),
      );

      // Keep observation delivery pending until all KV calls have returned.
      for (const path of ["/app/kv", "/connector/kv"]) {
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

      for (const path of ["/app/production-kv", "/connector/production-kv"]) {
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

      // A rejected observer request must not change the already successful KV results.
      for (const response of pending) response.writeHead(503).end();
      pending.length = 0;
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
