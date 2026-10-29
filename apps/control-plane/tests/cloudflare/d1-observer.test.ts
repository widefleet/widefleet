import { describe, expect, it } from "vitest";
import { build } from "esbuild";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const observation = z.strictObject({
  identity: z.json(),
  event: z.strictObject({
    timestamp: z.number(),
    binding: z.literal("DB"),
    operation: z.enum(["all", "first", "raw", "batch", "exec"]),
    statements: z.number(),
    outcome: z.enum(["ok", "error", "unknown"]),
    rowsRead: z.number().nullable(),
    rowsWritten: z.number().nullable(),
  }),
});

const normalize = (value: z.infer<ReturnType<typeof z.json>>) =>
  z
    .json()
    .parse(
      JSON.parse(
        JSON.stringify(value, (key, entry) =>
          ["duration", "sql_duration_ms"].includes(key) ? 0 : z.json().parse(entry),
        ),
      ),
    );

const scenarios = [
  "prepare",
  "raw",
  "empty",
  "types",
  "all",
  "first",
  "column",
  "missing",
  "raw-write",
  "run",
  "batch",
  "exec",
  "error",
  "batch-error",
  "exec-error",
  "session",
];

describe.runIf(process.env["RUN_CLOUDFLARE_TESTS"] === "1")("D1 observation in workerd", () => {
  it.each([false, true])(
    "preserves native behavior through app/service builders (hook=%s)",
    async (enabled) => {
      const directory = await mkdtemp(join(tmpdir(), "widefleet-d1-observer-"));
      const observations: z.infer<typeof observation>[] = [];
      const errors: Error[] = [];
      let rejectDelivery = false;

      const collector = createServer((request, response) => {
        const handle = async () => {
          const chunks: Uint8Array[] = [];

          for await (const chunk of request) chunks.push(z.instanceof(Uint8Array).parse(chunk));
          observations.push(observation.parse(JSON.parse(Buffer.concat(chunks).toString())));
          response.writeHead(rejectDelivery ? 503 : 204).end();
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
        const extension = fileURLToPath(new URL("../fixtures/d1-extension.ts", runtime));
        const aliases = enabled ? { "#runtime-extension": extension } : {};

        const child = async (entry: string) => {
          const result = await build({
            entryPoints: [fileURLToPath(new URL(`${entry}.ts`, runtime))],
            bundle: true,
            format: "esm",
            platform: "browser",
            external: ["cloudflare:*", "node:*", "./__widefleet_app.js"],
            alias: { "#runtime-extension": extension, "widefleet:app": "./__widefleet_app.js" },
            write: false,
          });

          return z.string().parse(result.outputFiles[0]?.text);
        };

        const bindings = await child("bindings");

        expect(bindings).not.toContain("D1_OBSERVER_ORIGIN");
        expect(bindings).not.toContain("D1 observation requires");

        const application = await build({
          stdin: {
            contents: `
            import { exerciseDatabase } from ${JSON.stringify(fileURLToPath(new URL("../fixtures/d1-scenarios.ts", runtime)))};
            import { drizzle } from 'drizzle-orm/d1';
            import { sqliteTable, integer, text } from 'drizzle-orm/sqlite-core';
            import { eq } from 'drizzle-orm';
            const items = sqliteTable('items', { id: integer('id'), name: text('name'), enabled: integer('enabled', { mode: 'boolean' }) });
            const children = sqliteTable('children', { id: integer('id'), ownerId: integer('owner_id') });
            export default { async fetch(request, env) {
              if ('D1_OBSERVER_ORIGIN' in env) throw new Error('Parent binding leaked');
              const scenario = new URL(request.url).pathname.split('/').at(-1);
              try {
                if (scenario === 'spoof') return Response.json(await env.DB.query({ method: 'first', statement: { sql: 'SELECT n FROM counter', parameters: [] }, column: 'n', binding: 'spoofed-binding', identity: { appId: 'spoofed-app', organizationId: 'spoofed-organization' } }));
                if (scenario === 'drizzle') return Response.json(await drizzle(env.DB).select({ left: items.id, right: children.id, name: items.name, enabled: items.enabled }).from(items).innerJoin(children, eq(items.id, children.ownerId)).orderBy(items.id));
                return Response.json(await exerciseDatabase(env.DB, scenario));
              } catch (error) { return Response.json({ error: error.message }); }
            } };`,
            resolveDir: dirname(fileURLToPath(import.meta.resolve("../../package.json"))),
          },
          bundle: true,
          format: "esm",
          platform: "browser",
          write: false,
        });

        const main = join(directory, "index.js");

        await build({
          entryPoints: [fileURLToPath(new URL("../fixtures/d1-observer.ts", runtime))],
          outfile: main,
          bundle: true,
          format: "esm",
          platform: "browser",
          external: ["cloudflare:*", "node:*"],
          alias: aliases,
          define: {
            WIDEFLEET_BINDINGS_SOURCE: JSON.stringify(bindings),
            WIDEFLEET_EVENTS_SOURCE: JSON.stringify(await child("events")),
            WIDEFLEET_WORKFLOW_SOURCE: JSON.stringify(""),
          },
        });
        const config = join(directory, "wrangler.json");

        await writeFile(
          config,
          JSON.stringify({
            name: "d1-observer-test",
            main,
            compatibility_date: "2026-10-01",
            compatibility_flags: ["nodejs_compat"],
            worker_loaders: [{ binding: "WIDEFLEET_LOADER" }],
            d1_databases: [
              {
                binding: "NATIVE_DB",
                database_name: "fixture",
                database_id: "00000000-0000-4000-8000-000000000001",
              },
            ],
            r2_buckets: [{ binding: "WIDEFLEET_PACKAGES", bucket_name: "d1-observer-packages" }],
            vars: {
              D1_OBSERVER_ORIGIN: `http://127.0.0.1:${port}`,
              D1_CHILD_SOURCE: application.outputFiles[0]?.text,
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
        const active = worker;

        const read = async (path: string) => {
          const response = await active.fetch(`http://fixture${path}`);

          expect(response.status, await response.clone().text()).toBe(200);

          return normalize(z.json().parse(await response.json()));
        };

        const reset = async () => {
          const response = await active.fetch("http://fixture/reset");

          expect(response.status, await response.text()).toBe(204);
        };

        let expectedEvents = 0;

        for (const scope of ["app", "service"]) {
          for (const scenario of scenarios) {
            await reset();
            const native = await read(`/native/${scenario}`);
            const nativeState = await read("/state");

            await reset();
            const before = observations.length;

            expect(await read(`/${scope}/${scenario}`), `${scope}/${scenario}`).toEqual(native);
            expect(await read("/state")).toEqual(nativeState);
            const calls = scenario === "prepare" ? 0 : scenario === "session" ? 2 : 1;

            expectedEvents += enabled ? calls : 0;

            if (enabled && calls) {
              await expect.poll(() => observations.length, { timeout: 8_000 }).toBe(expectedEvents);
              const events = observations.slice(before);

              expect(events.every(({ event }) => event.binding === "DB")).toBe(true);

              if (scenario.endsWith("error"))
                expect(events[0]?.event).toMatchObject({
                  outcome: "error",
                  rowsRead: null,
                  rowsWritten: null,
                });
              else
                expect(
                  events.every(
                    ({ event }) =>
                      event.outcome === "ok" &&
                      event.rowsRead !== null &&
                      event.rowsWritten !== null,
                  ),
                ).toBe(true);

              if (["batch", "exec", "batch-error", "exec-error"].includes(scenario))
                expect(events[0]?.event.statements).toBe(2);

              if (scenario === "missing") expect(events[0]?.event.rowsRead).toBe(2);

              if (["raw-write", "run", "batch", "exec"].includes(scenario))
                expect(events[0]?.event.rowsWritten).toBe(1);
            }
          }
        }

        await reset();
        const results = await Promise.all([read("/app/drizzle"), read("/service/drizzle")]);

        for (const result of results)
          expect(result).toEqual([
            { left: 1, right: 10, name: "one", enabled: true },
            { left: 2, right: 20, name: "two", enabled: false },
          ]);
        expectedEvents += enabled ? 2 : 0;

        if (enabled) await expect.poll(() => observations.length).toBe(expectedEvents);
        expect(observations.slice(-2).map(({ identity }) => identity)).toEqual(
          enabled
            ? expect.arrayContaining([
                {
                  appId: "a0000000-0000-4000-8000-000000000001",
                  deploymentId: "a0000000-0000-4000-8000-000000000002",
                  buildId: null,
                },
                {
                  organizationId: "observer-fixture",
                  appId: "a0000000-0000-4000-8000-000000000004",
                  buildId: null,
                  deploymentId: "a0000000-0000-4000-8000-000000000003",
                },
              ])
            : [],
        );
        expect(await read("/app/spoof")).toBe(0);
        expectedEvents += enabled ? 1 : 0;

        if (enabled) {
          await expect.poll(() => observations.length).toBe(expectedEvents);
          expect(observations.at(-1)).toMatchObject({
            identity: { appId: "a0000000-0000-4000-8000-000000000001" },
            event: { binding: "DB", operation: "first" },
          });
        }

        expect(JSON.stringify(observations)).not.toMatch(/spoofed/);
        rejectDelivery = true;
        await reset();
        expect(await read("/app/raw-write")).toEqual([[1, 11]]);
        expect(await read("/state")).toEqual({ n: 1, unchanged: true });
        expectedEvents += enabled ? 1 : 0;

        if (enabled) await expect.poll(() => observations.length).toBe(expectedEvents);
        await reset();
        expect(await read("/unobservable")).toEqual([[1, 11]]);
        expect(await read("/state")).toEqual({ n: 1, unchanged: true });
        expect(observations).toHaveLength(expectedEvents);
        expect(JSON.stringify(observations)).not.toMatch(
          /private-|SELECT|UPDATE|INSERT|SQLITE_ERROR|parameters|results|bookmark|size_after/,
        );
        expect(errors).toEqual([]);
      } finally {
        await worker?.stop();
        await new Promise<void>((resolve, reject) =>
          collector.close((error) => (error ? reject(error) : resolve())),
        );
        await rm(directory, { recursive: true, force: true });
      }
    },
    60_000,
  );
});
