import { chromium } from "@playwright/test";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

const execute = promisify(execFile);

const root = fileURLToPath(new URL("../../../../", import.meta.url));

const entry = z.object({
  widefleet: z.literal(1),
  kind: z.enum(["error", "request"]),
  source: z.enum(["server", "browser"]),
  message: z.string(),
  buildId: z.string(),
  route: z.string(),
  requestId: z.uuid(),
  stack: z.string().nullable().optional(),
  status: z.number().optional(),
});

describe.runIf(process.env["RUN_CAPTURE_TESTS"] === "1")("production starter error capture", () => {
  it("captures server and browser failures, preserves the browser version, and bounds ingestion", async () => {
    const directory = await mkdtemp(join(tmpdir(), "widefleet-capture-test-"));
    const starter = join(root, "starters/sveltekit");
    const listener = createServer();
    listener.listen(0, "127.0.0.1");
    await once(listener, "listening");
    const { port } = z.object({ port: z.number() }).parse(listener.address());
    await new Promise<void>((resolve, reject) =>
      listener.close((error) => (error ? reject(error) : resolve())),
    );
    const origin = `http://127.0.0.1:${port}`;
    const browser = await chromium.launch({ headless: true });
    let output = "";
    let runtime: ReturnType<typeof spawn> | undefined;

    const entries = () =>
      output.split("\n").flatMap((line) => {
        const start = line.indexOf('{"widefleet":1,');

        if (start < 0) return [];
        const parsed = entry.safeParse(JSON.parse(line.slice(start)));

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
      await rm(join(directory, "src/routes/+page.server.ts"));
      await writeFile(
        join(directory, "src/routes/+page.svelte"),
        `<script>
        import { captureError } from '../lib/capture-error.ts';
        import { onMount } from 'svelte';
        let ready = $state(false);
        onMount(() => { ready = true; });
      </script>
      <button disabled={!ready} onclick={() => { throw new Error('browser-event-fixture'); }}>Throw</button>
      <button disabled={!ready} onclick={() => { void Promise.reject(new Error('browser-promise-fixture')); }}>Reject</button>
      <button disabled={!ready} onclick={() => { const cause = new Error('browser-handled-fixture'); captureError(cause); captureError(cause); }}>Handled</button>
      <a href="/navigation">Navigate</a>`,
      );
      await mkdir(join(directory, "src/routes/probe"));
      await writeFile(
        join(directory, "src/routes/probe/+server.ts"),
        `import { error } from '@sveltejs/kit';
        import { captureError } from '../../lib/server/capture-error.ts';
        export const GET = (event) => {
          const mode = event.url.searchParams.get('mode');
          if (mode === 'expected') error(403, 'expected-fixture');
          if (mode === 'http') error(500, 'http-error-fixture');
          if (mode === 'raw') return new Response('unavailable', { status: 503 });
          if (mode === 'handled') { captureError(new Error('server-handled-fixture'), event); return new Response('handled'); }
          throw new Error('server-throw-fixture', { cause: new Error('root-cause-fixture') });
        };`,
      );
      await mkdir(join(directory, "src/routes/navigation"));
      await writeFile(
        join(directory, "src/routes/navigation/+page.ts"),
        "export const load = () => { throw new Error('client-navigation-fixture'); }; export const ssr = false;",
      );
      await writeFile(
        join(directory, "src/routes/navigation/+page.svelte"),
        "<p>Navigation fixture</p>",
      );
      await execute(process.execPath, [join(starter, "node_modules/vite/bin/vite.js"), "build"], {
        cwd: directory,
        maxBuffer: 8 * 1024 * 1024,
      });
      await execute(process.execPath, ["tools/prepare.ts"], { cwd: directory });
      await execute(
        join(root, "node_modules/.bin/esbuild"),
        [
          "build/worker.js",
          "--bundle",
          "--format=esm",
          "--platform=browser",
          "--target=es2022",
          "--external:node:*",
          "--external:cloudflare:workers",
          "--sourcemap=external",
          "--outfile=runtime.js",
        ],
        { cwd: directory },
      );

      const map = z
        .object({ sources: z.array(z.string()), sourcesContent: z.array(z.string().nullable()) })
        .parse(JSON.parse(await readFile(join(directory, "runtime.js.map"), "utf8")));

      expect(map.sources.some((source) => source.endsWith("src/routes/probe/+server.ts"))).toBe(
        true,
      );
      expect(map.sourcesContent.some((source) => source?.includes("root-cause-fixture"))).toBe(
        true,
      );

      const version = z
        .object({ version: z.string() })
        .parse(
          JSON.parse(await readFile(join(directory, "build/public/_app/version.json"), "utf8")),
        ).version;

      const config = z
        .object({ compatibility_date: z.string(), compatibility_flags: z.array(z.string()) })
        .parse(
          JSON.parse(
            await readFile(join(directory, "wrangler.jsonc"), "utf8").then((text) =>
              text.replace(/,\s*([}\]])/g, "$1"),
            ),
          ),
        );

      await writeFile(
        join(directory, "runtime.json"),
        JSON.stringify({
          ...config,
          name: "capture-fixture",
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
        "x-auth-request-user": "capture-test",
        "x-auth-request-preferred-username": "Capture Test",
        origin,
      };

      await vi.waitFor(async () => expect((await fetch(origin, { headers })).status).toBe(200), {
        timeout: 30_000,
      });
      expect((await fetch(`${origin}/probe`, { headers })).status).toBe(500);
      expect((await fetch(`${origin}/probe?mode=raw`, { headers })).status).toBe(503);
      expect((await fetch(`${origin}/probe?mode=http`, { headers })).status).toBe(500);
      expect((await fetch(`${origin}/probe?mode=expected`, { headers })).status).toBe(403);
      expect((await fetch(`${origin}/probe?mode=handled`, { headers })).status).toBe(200);
      const page = await browser.newPage({ extraHTTPHeaders: headers });
      await page.goto(origin);
      // Hydration installs the Svelte handlers and the global hooks.
      await page.waitForFunction(
        () => document.querySelector("button")?.hasAttribute("disabled") === false,
      );
      await page.getByRole("button", { name: "Throw", exact: true }).click();
      await page.getByRole("button", { name: "Reject", exact: true }).click();
      await page.getByRole("button", { name: "Handled", exact: true }).click();
      await page.getByRole("link", { name: "Navigate" }).click();
      await vi.waitFor(
        () => expect(entries().filter((item) => item.source === "browser")).toHaveLength(4),
        { timeout: 10_000 },
      );
      const errors = entries().filter((item) => item.kind === "error");
      expect(errors.find((item) => item.message === "server-throw-fixture")?.stack).toContain(
        "root-cause-fixture",
      );
      expect(errors.find((item) => item.message === "server-throw-fixture")?.route).toBe("/probe");
      expect(errors.filter((item) => item.message === "browser-handled-fixture")).toHaveLength(1);
      expect(errors.every((item) => item.buildId === version)).toBe(true);
      expect(errors.some((item) => item.message === "expected-fixture")).toBe(false);
      expect(errors.some((item) => item.message === "http-error-fixture")).toBe(true);
      expect(entries().some((item) => item.status === 503)).toBe(true);

      const body = JSON.stringify({
        id: crypto.randomUUID(),
        buildId: "previous-browser-version",
        message: "old-tab-fixture",
        route: "/old-page",
        stack: "Error: old-tab-fixture",
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
        expect(entries().filter((item) => item.message === "old-tab-fixture")).toHaveLength(1),
      );
      expect(entries().find((item) => item.message === "old-tab-fixture")?.buildId).toBe(
        "previous-browser-version",
      );
      let lastStatus = 0;

      for (let count = 0; count < 31; count += 1) lastStatus = (await report()).status;
      expect(lastStatus).toBe(429);
    } catch (cause) {
      throw new Error(`Capture fixture failed. Runtime output:\n${output.slice(-8000)}`, { cause });
    } finally {
      await browser.close();

      if (runtime && runtime.exitCode === null) {
        const closed = once(runtime, "close");
        runtime.kill("SIGINT");
        await closed;
      }

      await rm(directory, { recursive: true, force: true });
    }
  }, 120_000);
});
