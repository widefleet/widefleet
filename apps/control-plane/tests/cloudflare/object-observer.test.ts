import { describe, expect, it } from "vitest";
import { build } from "esbuild";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const observation = z.strictObject({
  identity: z.json(),
  event: z.strictObject({
    timestamp: z.number().positive(),
    binding: z.literal("FILES"),
    count: z.literal(1),
    operation: z.enum([
      "get",
      "head",
      "put",
      "delete",
      "list",
      "createMultipartUpload",
      "uploadPart",
      "complete",
      "abort",
    ]),
    outcome: z.enum(["ok", "not_found", "precondition_failed", "error"]),
  }),
});

describe.runIf(process.env["RUN_CLOUDFLARE_TESTS"] === "1")("R2 observer in workerd", () => {
  it("preserves native app and connector behavior with a pending, then failing collector", async () => {
    const directory = await mkdtemp(join(tmpdir(), "widefleet-objects-"));
    const observations: z.infer<typeof observation>[] = [];
    const errors: Error[] = [];
    const pending: ServerResponse[] = [];
    let rejecting = false;

    const collector = createServer((request, response) => {
      const handle = async () => {
        const chunks: Uint8Array[] = [];

        for await (const chunk of request) chunks.push(z.instanceof(Uint8Array).parse(chunk));
        observations.push(observation.parse(JSON.parse(Buffer.concat(chunks).toString())));

        if (rejecting) response.writeHead(503).end();
        else pending.push(response);
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
      const extension = fileURLToPath(new URL("../fixtures/objects-extension.ts", runtime));

      const child = async (entry: string) => {
        const result = await build({
          entryPoints: [fileURLToPath(new URL(`${entry}.ts`, runtime))],
          bundle: true,
          format: "esm",
          platform: "browser",
          external: ["cloudflare:*", "node:*", "./__widefleet_app.js", "./__widefleet_workflow.js"],
          alias: {
            "#runtime-extension": extension,
            "widefleet:app": "./__widefleet_app.js",
            "widefleet:workflow": "./__widefleet_workflow.js",
          },
          write: false,
        });

        const source = z.string().parse(result.outputFiles[0]?.text);
        expect(source).not.toContain("OBSERVER_LABEL");
        expect(source).not.toContain("Object observer fixture rejected");

        return source;
      };

      const define = {
        WIDEFLEET_BINDINGS_SOURCE: JSON.stringify(await child("bindings")),
        WIDEFLEET_EVENTS_SOURCE: JSON.stringify(await child("events")),
        WIDEFLEET_WORKFLOW_SOURCE: JSON.stringify(await child("workflow-runner")),
      };

      await child("workflow-cloudflare-runner");
      const baseline: unknown[] = [];

      for (const enabled of [false, true]) {
        const main = join(directory, `index-${enabled}.js`);
        await build({
          entryPoints: [fileURLToPath(new URL("../fixtures/objects.ts", runtime))],
          outfile: main,
          bundle: true,
          format: "esm",
          platform: "browser",
          external: ["cloudflare:*", "node:*"],
          alias: enabled ? { "#runtime-extension": extension } : {},
          define,
        });
        const config = join(directory, "wrangler.json");
        await writeFile(
          config,
          JSON.stringify({
            name: "object-observer-test",
            main,
            compatibility_date: "2026-10-01",
            compatibility_flags: ["nodejs_compat"],
            worker_loaders: [{ binding: "WIDEFLEET_LOADER" }],
            r2_buckets: [
              { binding: "WIDEFLEET_PACKAGES", bucket_name: "objects-packages" },
              { binding: "APP_OBJECTS", bucket_name: "app-objects" },
              { binding: "CONNECTOR_OBJECTS", bucket_name: "connector-objects" },
            ],
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
          experimental: {
            disableExperimentalWarning: true,
            disableDevRegistry: true,
            watch: false,
          },
        });

        for (const path of ["/app", "/connector"]) {
          const resumed = await worker.fetch(`http://fixture${path}/resume`);
          expect(await resumed.json()).toEqual({ handle: true });
        }

        expect(observations).toEqual([]);

        for (const path of ["/app", "/connector"]) {
          const response = await worker.fetch(`http://fixture${path}`);
          expect(response.status, await response.clone().text()).toBe(200);
          const result = await response.json();
          expect(result).toEqual({
            missingHead: null,
            missingGet: null,
            size: 12,
            metadata: { secret: "private-metadata" },
            contentType: "text/plain",
            value: "private-body",
            bodyUsedBefore: false,
            bodyUsedAfter: true,
            rangeValue: "ivat",
            range: { offset: 2, length: 4 },
            conditionalHasBody: false,
            allowedValue: "private-body",
            rejectedPut: null,
            unchanged: "private-body",
            pages: [1, 1],
            truncated: true,
            empty: 0,
            completedSize: 14,
            multipartValue: "multipart-body",
            nativeErrors: [
              expect.any(String),
              expect.any(String),
              expect.any(String),
              expect.any(String),
              expect.any(String),
            ],
            unexpectedBindings: [],
            invalidInputRejected: true,
          });

          if (enabled) expect(result).toEqual(baseline.shift());
          else baseline.push(result);
        }

        if (enabled) {
          await expect.poll(() => observations.length, { timeout: 8_000 }).toBe(60);

          for (const identity of [
            {
              appId: "a0000000-0000-4000-8000-000000000001",
              hostname: "objects.example.test",
              deploymentId: "a0000000-0000-4000-8000-000000000002",
              buildId: null,
            },
            {
              organizationId: "objects-fixture",
              connector: "fixture",
              connectorVersion: "a0000000-0000-4000-8000-000000000003",
            },
          ]) {
            const events = observations.flatMap((item) =>
              JSON.stringify(item.identity) === JSON.stringify(identity) ? [item.event] : [],
            );

            expect(events).toHaveLength(30);
            expect(events.filter((event) => event.outcome === "error")).toHaveLength(5);
            expect(
              events
                .flatMap((event) => (event.outcome === "not_found" ? [event.operation] : []))
                .sort(),
            ).toEqual(["get", "head"]);
            expect(
              events
                .flatMap((event) =>
                  event.outcome === "precondition_failed" ? [event.operation] : [],
                )
                .sort(),
            ).toEqual(["get", "put"]);
            expect(events.map((event) => event.operation).sort()).toEqual(
              [
                ...Array<string>(8).fill("get"),
                ...Array<string>(2).fill("head"),
                ...Array<string>(5).fill("put"),
                ...Array<string>(4).fill("delete"),
                ...Array<string>(4).fill("list"),
                "createMultipartUpload",
                "createMultipartUpload",
                "uploadPart",
                "uploadPart",
                "complete",
                "complete",
                "abort",
              ].sort(),
            );
          }

          expect(JSON.stringify(observations)).not.toMatch(
            /private-|multipart-body|uploadId|customMetadata|etag/,
          );
          rejecting = true;

          for (const response of pending) response.writeHead(503).end();
          pending.length = 0;

          for (const path of ["/app", "/connector"]) {
            const response = await worker.fetch(`http://fixture${path}/stream`);
            expect(response.status).toBe(200);
            expect(await response.text()).toBe("private-body");
          }

          await expect.poll(() => observations.length, { timeout: 8_000 }).toBe(62);
          expect(observations.slice(60).map((item) => item.event.outcome)).toEqual(["ok", "ok"]);
        } else expect(observations).toEqual([]);
        await worker.stop();
        worker = undefined;
      }

      expect(errors).toEqual([]);
    } finally {
      for (const response of pending) response.writeHead(503).end();
      await worker?.stop();
      await new Promise<void>((resolve, reject) =>
        collector.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(directory, { recursive: true, force: true });
    }
  }, 40_000);
});
