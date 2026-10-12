import { chromium } from "@playwright/test";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

const execute = promisify(execFile);

const root = fileURLToPath(new URL("../../../../", import.meta.url));

const record = z.object({
  widefleet: z.literal(1),
  kind: z.enum(["error", "request"]),
  source: z.enum(["server", "browser"]),
  message: z.string(),
  buildId: z.string(),
  requestId: z.uuid(),
  route: z.string(),
  status: z.number().optional(),
  stack: z.string().nullable().optional(),
});

describe.runIf(process.env["RUN_CAPTURE_TESTS"] === "1")("TanStack Start on celld", () => {
  it("serves authenticated SSR, server functions and private storage with versioned error capture", async () => {
    const directory = await mkdtemp(join(tmpdir(), "widefleet-tanstack-test-"));
    const starter = join(root, "starters/tanstack-start");
    const listener = createServer();

    listener.listen(0, "127.0.0.1");
    await once(listener, "listening");
    const { port } = z.object({ port: z.number() }).parse(listener.address());

    await new Promise<void>((resolve, reject) =>
      listener.close((error) => (error ? reject(error) : resolve())),
    );
    const origin = `http://127.0.0.1:${port}`;
    const browser = await chromium.launch({ headless: true });
    let runtime: ReturnType<typeof spawn> | undefined;
    let output = "";

    const entries = () =>
      output.split("\n").flatMap((line) => {
        const start = line.indexOf('{"widefleet":1,');

        if (start < 0) return [];
        const parsed = record.safeParse(JSON.parse(line.slice(start)));

        return parsed.success ? [parsed.data] : [];
      });

    try {
      for (const file of [
        "src",
        "tools",
        "vite.config.ts",
        "tsconfig.json",
        "wrangler.jsonc",
        "package.json",
      ])
        await cp(join(starter, file), join(directory, file), { recursive: true });
      await symlink(join(starter, "node_modules"), join(directory, "node_modules"), "dir");
      await writeFile(
        join(directory, "src/lib/failure.functions.ts"),
        `
        import { createServerFn } from '@tanstack/react-start';
        export const fail = createServerFn({ method: 'POST' }).handler(() => {
          throw new Error('server-function-fixture');
        });
      `,
      );
      await writeFile(
        join(directory, "src/routes/diagnostics.tsx"),
        `
        import { createFileRoute, Link } from '@tanstack/react-router';
        import { useEffect, useState } from 'react';
        import { captureError } from '../lib/capture-error.ts';
        import { fail } from '../lib/failure.functions.ts';
        export const Route = createFileRoute('/diagnostics')({ component: Diagnostics });
        function Diagnostics() {
          const [ready, setReady] = useState(false);
          useEffect(() => setReady(true), []);
          return <>
            <button disabled={!ready} onClick={() => { throw new Error('browser-event-fixture'); }}>Throw</button>
            <button disabled={!ready} onClick={() => { void Promise.reject(new Error('browser-promise-fixture')); }}>Reject</button>
            <button disabled={!ready} onClick={() => { const error = new Error('browser-handled-fixture'); captureError(error); captureError(error); }}>Handled</button>
            <button disabled={!ready} onClick={() => { void fail().catch(() => {}); }}>Server failure</button>
            <Link to='/failure'>Navigate</Link>
          </>;
        }
      `,
      );
      await writeFile(
        join(directory, "src/routes/failure.tsx"),
        `
        import { createFileRoute } from '@tanstack/react-router';
        export const Route = createFileRoute('/failure')({
          loader: () => { throw new Error('route-loader-fixture'); },
          component: () => <p>Unavailable</p>,
        });
      `,
      );
      await writeFile(
        join(directory, "src/routes/probe.ts"),
        `
        import { createFileRoute } from '@tanstack/react-router';
        import { captureError } from '../lib/server/capture-error.ts';
        export const Route = createFileRoute('/probe')({ server: { handlers: {
          GET: ({ request }) => {
            const mode = new URL(request.url).searchParams.get('mode');
            if (mode === 'expected') return new Response('expected-fixture', { status: 403 });
            if (mode === 'raw') return new Response('unavailable', { status: 503 });
            if (mode === 'handled') { captureError(new Error('server-handled-fixture')); return new Response('handled'); }
            throw new Error('server-throw-fixture', { cause: new Error('root-cause-fixture') });
          }
        } } });
      `,
      );
      await execute(process.execPath, ["tools/build.ts"], {
        cwd: directory,
        maxBuffer: 8 * 1024 * 1024,
      });
      await execute(
        join(root, "node_modules/.bin/esbuild"),
        [
          "build/server/index.js",
          "--bundle",
          "--format=esm",
          "--platform=browser",
          "--target=es2022",
          "--conditions=workerd,worker,browser",
          "--external:node:*",
          "--external:cloudflare:workers",
          "--sourcemap=external",
          "--outfile=runtime.js",
        ],
        { cwd: directory },
      );

      const map = z
        .object({ sources: z.array(z.string()) })
        .parse(JSON.parse(await readFile(join(directory, "runtime.js.map"), "utf8")));

      expect(map.sources.some((source) => source.endsWith("src/routes/probe.ts"))).toBe(true);

      const version = z
        .object({ version: z.string() })
        .parse(
          JSON.parse(
            await readFile(join(directory, "build/public/_widefleet/version.json"), "utf8"),
          ),
        ).version;

      const config = z
        .record(z.string(), z.unknown())
        .parse(
          JSON.parse(
            (await readFile(join(directory, "wrangler.jsonc"), "utf8")).replace(
              /,\s*([}\]])/g,
              "$1",
            ),
          ),
        );

      await writeFile(
        join(directory, "runtime.json"),
        JSON.stringify({
          ...z
            .object({
              compatibility_date: z.string(),
              compatibility_flags: z.array(z.string()),
              d1_databases: z.array(z.record(z.string(), z.string())),
              r2_buckets: z.array(z.record(z.string(), z.string())),
              vars: z.record(z.string(), z.string()),
            })
            .parse(config),
          name: "tanstack-fixture",
          main: "runtime.js",
          no_bundle: true,
          assets: { directory: "build/public", binding: "ASSETS" },
        }),
      );
      runtime = spawn(
        join(root, ".tools/celld"),
        [
          "dev",
          "runtime.json",
          "--host",
          "127.0.0.1",
          "--port",
          String(port),
          "--logs",
          "--no-watch",
        ],
        {
          cwd: directory,
          env: { PATH: process.env["PATH"], RUST_LOG: "info", CELLD_OTEL: "0" },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      runtime.stdout?.on("data", (bytes: Buffer) => {
        output += bytes.toString();
      });
      runtime.stderr?.on("data", (bytes: Buffer) => {
        output += bytes.toString();
      });

      const headers = {
        "x-auth-request-user": "tanstack-test",
        "x-auth-request-preferred-username": "Fixture User",
        origin,
      };

      await vi.waitFor(async () => expect((await fetch(origin, { headers })).status).toBe(200), {
        timeout: 30_000,
      });
      expect((await fetch(origin)).status).toBe(401);
      const page = await browser.newPage({ extraHTTPHeaders: headers });

      await page.goto(origin);
      await expect.poll(() => page.textContent("body")).toContain("Angemeldet als Fixture User");
      await page.getByLabel("Deine Notiz").fill("Persisted TanStack note");
      await page.getByLabel("Ein Foto dazu").setInputFiles({
        name: "fixture.png",
        mimeType: "image/png",
        buffer: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=",
          "base64",
        ),
      });

      const mutation = page.waitForRequest(
        (request) => request.method() === "POST" && request.url().includes("/_serverFn/"),
      );

      await page.getByRole("button", { name: "Notiz teilen", exact: true }).click();
      const submitted = await mutation;

      await expect
        .poll(() => page.locator('[role="status"]').textContent())
        .toContain("Deine Notiz wurde gespeichert.");
      await page.reload();
      expect(await page.textContent("article")).toContain("Persisted TanStack note");
      const photo = await page.locator("article img").getAttribute("src");
      const file = await fetch(`${origin}${photo}`, { headers });

      expect(file.status).toBe(200);
      expect(file.headers.get("cache-control")).toBe("private, no-store");
      expect((await file.arrayBuffer()).byteLength).toBeGreaterThan(0);
      expect((await fetch(`${origin}${photo}`)).status).toBe(401);
      expect((await fetch(`${origin}/photos/invalid`, { headers })).status).toBe(404);
      expect(
        (
          await fetch(submitted.url(), {
            method: "POST",
            headers: { ...headers, origin: "https://foreign.example.test" },
          })
        ).status,
      ).toBe(403);
      expect((await fetch(submitted.url(), { method: "POST", headers: { origin } })).status).toBe(
        401,
      );
      expect((await fetch(`${origin}/probe`, { headers })).status).toBe(500);
      expect((await fetch(`${origin}/probe?mode=raw`, { headers })).status).toBe(503);
      expect((await fetch(`${origin}/probe?mode=expected`, { headers })).status).toBe(403);
      expect((await fetch(`${origin}/probe?mode=handled`, { headers })).status).toBe(200);
      expect((await fetch(`${origin}/failure`, { headers })).status).toBe(500);
      await page.goto(`${origin}/diagnostics`);
      await page.getByRole("button", { name: "Throw", exact: true }).click();
      await page.getByRole("button", { name: "Reject", exact: true }).click();
      await page.getByRole("button", { name: "Handled", exact: true }).click();
      await page.getByRole("button", { name: "Server failure", exact: true }).click();
      await page.getByRole("link", { name: "Navigate", exact: true }).click();
      await vi.waitFor(
        () => {
          const errors = entries().filter((entry) => entry.kind === "error");

          for (const message of [
            "server-throw-fixture",
            "server-handled-fixture",
            "server-function-fixture",
            "route-loader-fixture",
          ])
            expect(
              errors.some((entry) => entry.source === "server" && entry.message === message),
            ).toBe(true);

          for (const message of [
            "browser-event-fixture",
            "browser-promise-fixture",
            "browser-handled-fixture",
            "route-loader-fixture",
          ])
            expect(
              errors.some((entry) => entry.source === "browser" && entry.message === message),
            ).toBe(true);
        },
        { timeout: 10_000 },
      );
      expect(entries().filter((entry) => entry.message === "browser-handled-fixture")).toHaveLength(
        1,
      );
      expect(entries().find((entry) => entry.message === "server-throw-fixture")?.stack).toContain(
        "root-cause-fixture",
      );
      expect(entries().some((entry) => entry.status === 503)).toBe(true);
      expect(
        entries()
          .filter((entry) => entry.kind === "error")
          .every((entry) => entry.buildId === version),
      ).toBe(true);

      const body = JSON.stringify({
        id: crypto.randomUUID(),
        buildId: "previous-browser-build",
        message: "old-tab-fixture",
        route: "/old-page",
        stack: null,
      });

      const report = (data = body, originHeader = origin) =>
        fetch(`${origin}/_widefleet/errors`, {
          method: "POST",
          headers: { ...headers, origin: originHeader, "content-type": "application/json" },
          body: data,
        });

      expect((await report(body, "https://foreign.example.test")).status).toBe(403);
      expect((await report("broken JSON")).status).toBe(400);
      expect((await report("x".repeat(33 * 1024))).status).toBe(413);
      expect((await report()).status).toBe(204);
      expect((await report()).status).toBe(204);
      await vi.waitFor(() =>
        expect(entries().filter((entry) => entry.message === "old-tab-fixture")).toHaveLength(1),
      );
      expect(entries().find((entry) => entry.message === "old-tab-fixture")?.buildId).toBe(
        "previous-browser-build",
      );
      let status = 0;

      for (let count = 0; count < 31; count += 1) status = (await report()).status;
      expect(status).toBe(429);
    } catch (cause) {
      throw new Error(`TanStack fixture failed. Runtime output:\n${output.slice(-12000)}`, {
        cause,
      });
    } finally {
      await browser.close();

      if (runtime && runtime.exitCode === null) {
        runtime.kill("SIGTERM");
        await once(runtime, "exit");
      }

      await rm(directory, { recursive: true, force: true });
    }
  }, 120_000);
});
