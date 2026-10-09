import { createHash } from "node:crypto";
import { forward, followRedirects } from "@platform/app-runtime/network";
import { transform } from "esbuild";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { createServer, request as tlsRequest } from "node:https";
import {
  createServer as createHttpServer,
  request as httpRequest,
  IncomingMessage,
  type ServerResponse,
} from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const execute = promisify(execFile);

const root = fileURLToPath(new URL("../../../../", import.meta.url));

// Real isolates, native storage, TLS servers and event delivery. The test-only
// parent transport below supplies trust for the local TLS certificate.
describe.runIf(process.env["RUN_DYNAMIC_TESTS"] === "1")(
  "Dynamic application capabilities on pinned celld",
  () => {
    let directory: string;
    let processHandle: ReturnType<typeof spawn>;
    let allowed: ReturnType<typeof createServer>;
    let denied: ReturnType<typeof createServer>;
    let collector: ReturnType<typeof createHttpServer>;
    let tlsRelay: ReturnType<typeof createHttpServer>;
    let cancellationServer: ReturnType<typeof createHttpServer>;
    const cancellationRequests = new Map<string, { response: ServerResponse; closed: boolean }>();
    const telemetryRecords: { authorization: string | undefined; body: string }[] = [];
    const deploymentId = crypto.randomUUID();
    let allowedOrigin: string;
    let deniedOrigin: string;
    let origin: string;
    let runtimeLogs = "";
    const hits: string[] = [];
    let uploadStarted = false;
    const certificates = getCACertificates("default");

    const listen = async (
      server: ReturnType<typeof createServer> | ReturnType<typeof createHttpServer>,
    ) => {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");

      return z.object({ port: z.number() }).parse(server.address()).port;
    };

    const stop = async () => {
      if (processHandle && processHandle.exitCode === null && processHandle.signalCode === null) {
        const exited = once(processHandle, "exit");
        processHandle.kill("SIGTERM");
        const timeout = setTimeout(() => processHandle.kill("SIGKILL"), 15000);
        await exited;
        clearTimeout(timeout);
      }
    };

    const start = async () => {
      const reservation = createHttpServer();
      const port = await listen(reservation);
      await new Promise<void>((resolve, reject) =>
        reservation.close((error) => (error ? reject(error) : resolve())),
      );
      origin = `http://127.0.0.1:${port}`;
      processHandle = spawn(
        join(root, ".tools/celld"),
        ["dev", directory, "--port", String(port), "--no-watch", "--logs"],
        {
          env: {
            ...process.env,
            CELLD_SHUTDOWN_TOTAL_MS: "2000",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      processHandle.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
        runtimeLogs += chunk;
      });
      processHandle.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
        runtimeLogs += chunk;
      });
      await vi.waitFor(
        async () => {
          if (processHandle.exitCode !== null) throw new Error(runtimeLogs);
          expect((await fetch(`${origin}/.well-known/celld/health`)).ok).toBe(true);
        },
        { timeout: 20000 },
      );
    };

    const call = async (operation: string, fields: Record<string, string> = {}) => {
      const response = await fetch(`${origin}/?${new URLSearchParams({ operation, ...fields })}`);
      const data = z.json().parse(await response.json());

      if (!response.ok) throw new Error(JSON.stringify(data));

      return data;
    };

    beforeAll(async () => {
      directory = await mkdtemp(join(tmpdir(), "widefleet-dynamic-test-"));
      await execute("openssl", [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        join(directory, "key.pem"),
        "-out",
        join(directory, "cert.pem"),
        "-days",
        "1",
        "-subj",
        "/CN=127.0.0.1",
        "-addext",
        "subjectAltName=IP:127.0.0.1",
      ]);

      setDefaultCACertificates([
        ...certificates,
        await readFile(join(directory, "cert.pem"), "utf8"),
      ]);

      const tls = {
        key: await readFile(join(directory, "key.pem")),
        cert: await readFile(join(directory, "cert.pem")),
      };

      denied = createServer(tls, (request, response) => {
        hits.push(`denied:${request.url}`);
        response.end(
          JSON.stringify({
            authorization: request.headers.authorization ?? null,
            cookie: request.headers.cookie ?? null,
          }),
        );
      });
      deniedOrigin = `https://127.0.0.1:${await listen(denied)}`;
      allowed = createServer(tls, (request, response) => {
        hits.push(`allowed:${request.url}`);

        if (request.url === "/upload" || request.url === "/upload-307") {
          let size = 0;
          request.on("data", (chunk: Uint8Array) => {
            size += chunk.byteLength;
            uploadStarted = true;
          });
          request.on("end", () => {
            if (request.url === "/upload-307")
              response.writeHead(307, { location: "/upload" }).end();
            else response.end(JSON.stringify({ size }));
          });
        } else if (request.url === "/redirect-denied")
          response.writeHead(302, { location: `${deniedOrigin}/leak` }).end();
        else if (request.url === "/redirect-allowed")
          response.writeHead(302, { location: "/ok" }).end();
        else if (request.url === "/redirect-cross")
          response.writeHead(302, { location: `${deniedOrigin}/granted` }).end();
        else if (request.url === "/redirect-307")
          response.writeHead(307, { location: "/ok" }).end();
        else if (request.url === "/loop") response.writeHead(302, { location: "/loop" }).end();
        else
          response.end(
            JSON.stringify({
              method: request.method,
              host: request.headers.host,
              authorization: request.headers.authorization ?? null,
            }),
          );
      });
      allowedOrigin = `https://127.0.0.1:${await listen(allowed)}`;
      // celld's pinned HTTP client uses compiled WebPKI roots and exposes no
      // custom-CA option. Relay only these synthetic TLS servers, without
      // redirect following. Child fetch, native globalOutbound and Gateway
      // remain real; only the parent's final socket transport is redirected.
      tlsRelay = createHttpServer((incoming, outgoing) => {
        const target = new URL(incoming.url ?? "/", "http://relay.fixture").searchParams.get("url");

        if (!target || ![allowedOrigin, deniedOrigin].includes(new URL(target).origin)) {
          outgoing.writeHead(403).end();

          return;
        }

        const headers = { ...incoming.headers };
        delete headers.host;

        const upstream = tlsRequest(target, { method: incoming.method, headers }, (response) => {
          outgoing.writeHead(response.statusCode ?? 502, response.headers);
          response.pipe(outgoing);
        });

        upstream.on("error", () => outgoing.writeHead(502).end());
        incoming.pipe(upstream);
      });
      const relayOrigin = `http://127.0.0.1:${await listen(tlsRelay)}`;
      collector = createHttpServer((request, response) => {
        let body = "";
        request.setEncoding("utf8").on("data", (chunk: string) => {
          body += chunk;
        });
        request.on("end", () => {
          telemetryRecords.push({ authorization: request.headers.authorization, body });
          response.end("{}");
        });
      });
      const telemetryOrigin = `http://127.0.0.1:${await listen(collector)}`;

      cancellationServer = createHttpServer((request, response) => {
        const id = new URL(request.url ?? "/", "http://cancellation.fixture").searchParams.get(
          "id",
        );

        if (!id) {
          response.writeHead(400).end();

          return;
        }

        const entry = { response, closed: false };
        cancellationRequests.set(id, entry);
        response.once("close", () => {
          entry.closed = true;
        });
        // The test controls when headers and body are sent so a disconnect
        // cannot accidentally be tested only after fetch has already resolved.
      });
      const cancellationOrigin = `http://127.0.0.1:${await listen(cancellationServer)}`;

      const bindings = [
        { type: "d1", name: "DB", database_name: "fixture" },
        { type: "r2_bucket", name: "FILES", bucket_name: "fixture" },
        { type: "kv_namespace", name: "KV", id: "fixture" },
        { type: "queue", name: "JOBS", queue: "fixture" },
      ];

      const metadata = {
        main_module: "app.js",
        compatibility_date: "2026-10-01",
        compatibility_flags: ["nodejs_compat"],
        bindings,
        assets: { binding: "ASSETS" },
      };

      const source = (
        await transform(
          await readFile(join(root, "packages/app-runtime/fixtures/app.ts"), "utf8"),
          { loader: "ts", format: "esm" },
        )
      ).code;

      const hash = createHash("sha256").update(source).digest("hex");
      const appId = crypto.randomUUID();
      const version = crypto.randomUUID();

      const assetFiles = [
        { path: "/asset.txt", text: "fixture asset", hash: "0".repeat(32) },
        { path: "/no-tag.txt", text: "fixture asset", hash: "0".repeat(32) },
        { path: "/weak-tag.txt", text: "fixture asset", hash: "0".repeat(32) },
        { path: "/about/index.html", text: "<p>about</p>", hash: "1".repeat(32) },
        { path: "/static/index.html", text: "<p>home</p>", hash: "4".repeat(32) },
        { path: "/loop", text: "same asset", hash: "5".repeat(32) },
        {
          path: "/_headers",
          text: '/asset.txt\n  Cache-Control: public, max-age=3600\n  X-Fixture: preserved\n  Content-Length: 999\n  ETag: "release-1"\n/no-tag.txt\n  ! ETag\n/weak-tag.txt\n  ETag: W/"release-weak"\n',
          hash: "2".repeat(32),
        },
        {
          path: "/_redirects",
          text: "/old /about/ 302\n/copy /asset.txt 200\n/loop /loop 200\n/rewritten /about/index.html 200\n/rewritten-clean /about 200\n/about/index.html /asset.txt 200\n",
          hash: "3".repeat(32),
        },
      ];

      const app = {
        id: crypto.randomUUID(),
        appId,
        version,
        deploymentId,
        hostname: "127.0.0.1",
        metadata: {
          ...metadata,
          debug: { build_id: "fixture-current-build", source_maps: {} },
          assets: { ...metadata.assets, upload_session: crypto.randomUUID() },
          crons: ["* * * * *"],
          queue_consumers: [{ queue: "fixture" }, { queue: "dead" }],
        },
        modules: [{ name: "app.js", type: "esm", sha256: hash, size: Buffer.byteLength(source) }],
        manifest: Object.fromEntries(
          assetFiles.map((asset) => [asset.path, { hash: asset.hash, size: asset.text.length }]),
        ),
        nativeBindings: { DB: "DB", FILES: "FILES", KV: "KV", JOBS: "JOBS" },
        capabilities: { UPSTREAM: "CANCELLATION" },
        telemetry: { url: telemetryOrigin, token: "fixture-telemetry-only" },
        network: {
          revision: 1,
          policy: { backend: [allowedOrigin], browser: [] },
        },
      };

      await writeFile(
        join(directory, "runtime.js"),
        await readFile(join(root, "packages/app-runtime/dist/loader.js")),
      );
      await writeFile(
        join(directory, "loader.js"),
        `
        import { WorkerEntrypoint } from 'cloudflare:workers';
        import runtime, { Gateway as NativeGateway } from './runtime.js';
        const nativeFetch = globalThis.fetch;
        globalThis.fetch = (input, init) => {
          const request = new Request(input, init);
          if (![${JSON.stringify(allowedOrigin)}, ${JSON.stringify(deniedOrigin)}].includes(new URL(request.url).origin)) return nativeFetch(request);
          if (request.redirect !== 'manual') throw new Error('Gateway must disable native redirect following');
          return nativeFetch(new Request(${JSON.stringify(relayOrigin)} + '/?url=' + encodeURIComponent(request.url), request));
        };
        // Exercise the real cross-isolate outbound stream without an external
        // TLS dependency. All other requests use the actual policy gateway.
        export class Gateway extends NativeGateway {
          async fetch(request) {
            if (new URL(request.url).origin !== 'https://stream.fixture') return super.fetch(request);
            let size = 0;
            const reader = request.body.getReader();
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              size += value.byteLength;
              await this.env.KV.put('upload-started', 'yes');
            }
            return Response.json({ size });
          }
        }
        export * from './runtime.js';
        export class Cancellation extends WorkerEntrypoint {
          fetch(request) {
            return nativeFetch(${JSON.stringify(cancellationOrigin)} + new URL(request.url).search, { signal: request.signal });
          }
        }
        const app = ${JSON.stringify(app)};
        let initialized;
        export default { ...runtime, async fetch(request, env, ctx) {
          initialized ??= (async () => {
            await env.WIDEFLEET_PACKAGES.put('apps/${appId}/modules/${hash}', ${JSON.stringify(source)});
            for (const asset of ${JSON.stringify(assetFiles)}) await env.WIDEFLEET_PACKAGES.put('apps/${appId}/assets/' + asset.hash, asset.text);
            await env.WIDEFLEET_PACKAGES.put('versions/${appId}/${version}.json', JSON.stringify(app));
            await env.WIDEFLEET_PACKAGES.put('hosts/127.0.0.1.json', JSON.stringify(app));
            const spaRules = '/* /index.html 200\\n';
            const spaHash = '${"6".repeat(32)}';
            await env.WIDEFLEET_PACKAGES.put('apps/${appId}/assets/' + spaHash, spaRules);
            await env.WIDEFLEET_PACKAGES.put('hosts/spa.fixture.json', JSON.stringify({
              ...app, hostname: 'spa.fixture',
              manifest: { ...app.manifest, '/index.html': app.manifest['/static/index.html'], '/_redirects': { hash: spaHash, size: spaRules.length } },
            }));
          })();
          await initialized;
          if (new URL(request.url).pathname.startsWith('/fixture/spa/')) {
            const url = new URL(request.url);
            url.hostname = 'spa.fixture';
            url.pathname = url.pathname.slice('/fixture/spa'.length);
            return runtime.fetch(new Request(url, request), env, ctx);
          }
          if (new URL(request.url).pathname === '/fixture/upload-progress') {
            if (request.method === 'DELETE') await env.KV.delete('upload-started');
            return Response.json(await env.KV.get('upload-started'));
          }
          if (new URL(request.url).pathname === '/fixture/version') {
            const next = { ...app, version: crypto.randomUUID() };
            await env.WIDEFLEET_PACKAGES.put('versions/${appId}/' + next.version + '.json', JSON.stringify(next));
            await env.WIDEFLEET_PACKAGES.put('hosts/127.0.0.1.json', JSON.stringify(next));
            return new Response(null, { status: 204 });
          }
          if (new URL(request.url).searchParams.get('operation') === 'abort') {
            const signal = AbortSignal.timeout(100);
            try {
              return await runtime.fetch(new Request(request, { signal }), env, ctx);
            } catch (error) {
              return Response.json({ aborted: signal.aborted, error: String(error) });
            }
          }
          return runtime.fetch(request, env, ctx);
        } };
      `,
      );
      await writeFile(
        join(directory, "wrangler.json"),
        JSON.stringify({
          name: "dynamic-fixture",
          main: "loader.js",
          no_bundle: false,
          compatibility_date: metadata.compatibility_date,
          compatibility_flags: metadata.compatibility_flags,
          vars: {
            PRIVATE_ROOT_SECRET: "must-not-be-visible",
            WIDEFLEET_CONTROL_TOKEN: "fixture-only",
            WIDEFLEET_CONFIGURATION: JSON.stringify({
              crons: { "* * * * *": ["127.0.0.1"] },
              queues: {
                fixture: { hostname: "127.0.0.1", queue: "fixture" },
                dead: { hostname: "127.0.0.1", queue: "dead" },
              },
            }),
          },
          worker_loaders: [{ binding: "WIDEFLEET_LOADER" }],
          services: [
            { binding: "CANCELLATION", service: "dynamic-fixture", entrypoint: "Cancellation" },
          ],
          d1_databases: [{ binding: "DB", database_name: "fixture" }],
          r2_buckets: [
            { binding: "FILES", bucket_name: "fixture" },
            { binding: "WIDEFLEET_PACKAGES", bucket_name: "widefleet-packages" },
          ],
          kv_namespaces: [{ binding: "KV", id: "fixture" }],
          triggers: { crons: ["* * * * *"] },
          queues: {
            producers: [{ binding: "JOBS", queue: "fixture" }],
            consumers: [
              {
                queue: "fixture",
                max_batch_size: 1,
                max_batch_timeout: 1,
                max_retries: 1,
                retry_delay: 1,
                dead_letter_queue: "dead",
              },
              { queue: "dead", max_batch_size: 1, max_batch_timeout: 1 },
            ],
          },
        }),
      );
      await start();
    }, 30000);

    afterAll(async () => {
      for (const entry of cancellationRequests.values()) entry.response.destroy();

      await stop();
      setDefaultCACertificates(certificates);

      for (const server of [allowed, denied, collector, tlsRelay, cancellationServer])
        if (server)
          await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          );

      if (directory) await rm(directory, { recursive: true, force: true });
    });

    it("provides the Worker global self inside a loaded app", async () => {
      expect(await call("self")).toBe(true);
    });

    it("honors the caller's abort signal when forwarding to a loaded app", async () => {
      const result = z
        .object({ aborted: z.boolean(), error: z.string() })
        .parse(await call("abort"));

      expect(result.aborted).toBe(true);
      expect(result.error).toContain("TimeoutError");
    });

    it.each(["GET", "POST"])(
      "propagates a %s client disconnect before headers without cancelling another request",
      async (method) => {
        const id = crypto.randomUUID();
        const controller = new AbortController();

        const pending = fetch(`${origin}/?operation=cancel-upstream&id=${id}`, {
          method,
          signal: controller.signal,
        });

        const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
        const otherId = crypto.randomUUID();
        const otherController = new AbortController();

        const other = fetch(`${origin}/?operation=cancel-upstream&id=${otherId}`, {
          signal: otherController.signal,
        });

        // Observe rejection immediately, including when cleanup aborts this
        // still-pending request after an earlier assertion fails.
        const otherResult = other.catch(() => null);

        try {
          await vi.waitFor(() => {
            expect(cancellationRequests.has(id)).toBe(true);
            expect(cancellationRequests.has(otherId)).toBe(true);
          });
          const entry = cancellationRequests.get(id);
          const otherEntry = cancellationRequests.get(otherId);

          if (!entry || !otherEntry) throw new Error("Cancellation request is missing");

          expect(entry.response.headersSent).toBe(false);
          controller.abort();
          await rejected;
          await vi.waitFor(() => expect(entry.closed).toBe(true), { timeout: 2000 });
          expect(entry.response.writableEnded).toBe(false);
          expect(otherEntry.closed).toBe(false);
          otherEntry.response.end("still active");
          expect(
            await z
              .instanceof(Response)
              .parse(await otherResult)
              .text(),
          ).toBe("still active");
          expect(await call("self")).toBe(true);
        } finally {
          controller.abort();
          otherController.abort();
          await rejected;
          await otherResult;
          cancellationRequests.get(id)?.response.destroy();
          cancellationRequests.get(otherId)?.response.destroy();
        }
      },
    );

    it("preserves response streaming and cancels the upstream when its reader closes", async () => {
      const id = crypto.randomUUID();
      const controller = new AbortController();

      const pending = fetch(`${origin}/?operation=cancel-upstream&id=${id}`, {
        signal: controller.signal,
      });

      try {
        await vi.waitFor(() => expect(cancellationRequests.has(id)).toBe(true));
        const entry = cancellationRequests.get(id);

        if (!entry) throw new Error("Cancellation request is missing");

        entry.response.writeHead(200, { "content-type": "text/event-stream" });
        entry.response.write("data: first\n\n");
        const response = await pending;
        const reader = response.body?.getReader();

        if (!reader) throw new Error("Streaming response body is missing");

        expect(response.headers.has("content-security-policy")).toBe(true);
        expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: first\n\n");
        expect(entry.response.writableEnded).toBe(false);
        await reader.cancel();
        await vi.waitFor(() => expect(entry.closed).toBe(true), { timeout: 2000 });
        expect(entry.response.writableEnded).toBe(false);
      } finally {
        controller.abort();
        await pending.catch(() => undefined);
        cancellationRequests.get(id)?.response.destroy();
      }
    });

    it("checks TLS destinations, redirect modes and authority headers against real local servers", async () => {
      const send = (path: string, redirect: RequestRedirect = "follow") =>
        followRedirects(new Request(`${allowedOrigin}${path}`, { redirect }), (request) =>
          forward(request, [allowedOrigin]),
        );

      expect((await send("/ok")).status).toBe(200);
      expect((await send("/redirect-denied")).status).toBe(403);
      expect((await send("/redirect-allowed")).redirected).toBe(true);
      expect((await send("/redirect-denied", "manual")).status).toBe(302);
      await expect(send("/redirect-denied", "error")).rejects.toThrow("redirect");
      await expect(send("/loop")).rejects.toThrow("redirect");

      const response = await forward(
        new Request(`${allowedOrigin}/ok`, { headers: { host: "different.example.test" } }),
        [allowedOrigin],
      );

      expect(z.object({ host: z.string() }).parse(await response.json()).host).toBe(
        new URL(allowedOrigin).host,
      );
      expect(hits.filter((hit) => hit.startsWith("denied:") && hit !== "denied:/granted")).toEqual(
        [],
      );
    });

    it("preserves POST bodies for 307 and drops credentials across origins", async () => {
      const retained = await followRedirects(
        new Request(`${allowedOrigin}/redirect-307`, { method: "POST", body: "fixture" }),
        (request) => forward(request, [allowedOrigin]),
      );

      expect(z.object({ method: z.string() }).parse(await retained.json()).method).toBe("POST");

      const rewritten = await followRedirects(
        new Request(`${allowedOrigin}/redirect-allowed`, { method: "POST", body: "fixture" }),
        (request) => forward(request, [allowedOrigin]),
      );

      expect(z.object({ method: z.string() }).parse(await rewritten.json()).method).toBe("GET");

      const crossed = await followRedirects(
        new Request(`${allowedOrigin}/redirect-cross`, {
          headers: { authorization: "Bearer fixture", cookie: "fixture=secret" },
        }),
        (request) => forward(request, [allowedOrigin, deniedOrigin]),
      );

      expect(
        z.object({ authorization: z.null(), cookie: z.null() }).parse(await crossed.json()),
      ).toEqual({ authorization: null, cookie: null });
    });

    it.each<RequestRedirect>(["manual", "error", "follow"])(
      "streams uploads without an unread clone in %s mode",
      async (redirect) => {
        uploadStarted = false;
        let chunks = 0;

        const options = {
          method: "POST",
          redirect,
          duplex: "half",
          body: new ReadableStream<Uint8Array>({
            async pull(controller) {
              // The server must receive bytes before the source finishes producing them.
              if (chunks === 4) await vi.waitFor(() => expect(uploadStarted).toBe(true));

              if (chunks++ === 64) controller.close();
              else controller.enqueue(new Uint8Array(64 * 1024));
            },
          }),
        };

        const input = new Request(`${allowedOrigin}/upload`, options);

        const response = await followRedirects(input, (request) =>
          forward(request, [allowedOrigin]),
        );

        expect(await response.json()).toEqual({ size: 4 * 1024 * 1024 });
        expect(input.bodyUsed).toBe(true);
      },
    );

    it("streams incoming uploads across the real Dynamic Worker outbound boundary before EOF", async () => {
      await fetch(`${origin}/fixture/upload-progress`, { method: "DELETE" });
      const request = httpRequest(`${origin}/?operation=proxy-upload`, { method: "POST" });
      const response = once(request, "response");

      try {
        request.write(new Uint8Array(4 * 1024 * 1024));
        await expect
          .poll(
            async () =>
              z.json().parse(await (await fetch(`${origin}/fixture/upload-progress`)).json()),
            {
              timeout: 10000,
            },
          )
          .toBe("yes");
        request.end();
        const [incoming] = z.tuple([z.instanceof(IncomingMessage)]).parse(await response);
        const chunks: Buffer[] = [];

        for await (const chunk of incoming) chunks.push(z.instanceof(Buffer).parse(chunk));
        expect(JSON.parse(Buffer.concat(chunks).toString())).toEqual({ size: 4 * 1024 * 1024 });
      } finally {
        request.destroy(new Error("Fixture upload finished"));
        await response.catch(() => undefined);
      }
    });

    it("replays small uploads and refuses to retain large bodies for redirects", async () => {
      const send = (size: number) =>
        followRedirects(
          new Request(`${allowedOrigin}/upload-307`, {
            method: "POST",
            body: new Uint8Array(size),
          }),
          (request) => forward(request, [allowedOrigin]),
        );

      expect(await (await send(64 * 1024)).json()).toEqual({ size: 64 * 1024 });
      const received = hits.filter((hit) => hit === "allowed:/upload").length;
      await expect(send(4 * 1024 * 1024)).rejects.toThrow("at most 1 MiB");
      expect(hits.filter((hit) => hit === "allowed:/upload")).toHaveLength(received);
    });

    it("follows allowed redirects and rejects denied hops through the child fetch and native gateway", async () => {
      const send = (path: string, redirect = "follow") =>
        call("fetch", { target: `${allowedOrigin}${path}`, redirect });

      expect(await send("/ok")).toMatchObject({ status: 200, redirected: false });
      expect(await send("/redirect-allowed")).toMatchObject({ status: 200, redirected: true });
      expect(await send("/redirect-denied")).toMatchObject({ status: 403, redirected: true });
      expect(await send("/redirect-denied", "manual")).toMatchObject({
        status: 302,
        redirected: false,
      });
      expect(
        z.object({ error: z.string() }).parse(await send("/redirect-denied", "error")).error,
      ).toContain("redirect");
      expect(z.object({ error: z.string() }).parse(await send("/loop")).error).toContain(
        "redirect",
      );

      const response = z.object({ body: z.string() }).parse(
        await call("fetch", {
          target: `${allowedOrigin}/ok`,
          host: "unapproved.example.test",
        }),
      );

      expect(JSON.parse(response.body)).toMatchObject({ host: new URL(allowedOrigin).host });
      expect(hits).not.toContain("denied:/leak");
    });

    it("enforces denials inside real child isolates and hides privileged parent bindings", async () => {
      expect(await call("fetch", { target: `${deniedOrigin}/blocked` })).toMatchObject({
        status: 403,
      });
      expect(
        await call("fetch", { target: allowedOrigin.replace("https:", "http:") }),
      ).toMatchObject({ status: 403 });

      const tcp = z
        .object({ error: z.string() })
        .parse(await call("tcp", { target: new URL(allowedOrigin).host }));

      expect(tcp.error).toContain("globalOutbound");

      const socket = z
        .object({ error: z.string() })
        .parse(await call("websocket", { target: deniedOrigin.replace("https:", "wss:") }));

      expect(socket.error).toContain("globalOutbound");
      expect(hits.filter((hit) => hit.startsWith("denied:") && hit !== "denied:/granted")).toEqual(
        [],
      );
      expect(await call("env")).not.toContain("PRIVATE_ROOT_SECRET");
      expect(await call("env")).not.toContain("WIDEFLEET_LOADER");
    });

    it("serves versioned assets with headers, redirects, rewrites and byte ranges", async () => {
      const full = await fetch(`${origin}/asset.txt`);
      expect(await full.text()).toBe("fixture asset");
      expect(full.headers.get("cache-control")).toBe("public, max-age=3600");
      expect(full.headers.get("x-fixture")).toBe("preserved");
      expect(full.headers.get("content-length")).not.toBe("999");
      expect(full.headers.get("etag")).toBe('"release-1"');

      const partial = await fetch(`${origin}/asset.txt`, {
        headers: { range: "bytes=8-", "if-range": '"release-1"' },
      });

      expect(partial.status).toBe(206);
      expect(await partial.text()).toBe("asset");
      expect(partial.headers.get("content-range")).toBe("bytes 8-12/13");
      expect((await fetch(`${origin}/asset.txt`, { headers: { range: "bytes=99-" } })).status).toBe(
        416,
      );
      expect(
        (
          await fetch(`${origin}/asset.txt`, {
            headers: { "if-none-match": full.headers.get("etag") ?? "" },
          })
        ).status,
      ).toBe(304);
      expect(
        (
          await fetch(`${origin}/asset.txt`, {
            headers: { range: "bytes=8-", "if-range": '"outdated"' },
          })
        ).status,
      ).toBe(200);

      const noTag = await fetch(`${origin}/no-tag.txt`, {
        headers: { "if-none-match": '"' + "0".repeat(32) + '"' },
      });

      expect(noTag.status).toBe(200);
      expect(noTag.headers.has("etag")).toBe(false);
      expect(
        (await fetch(`${origin}/no-tag.txt`, { headers: { "if-none-match": "*" } })).status,
      ).toBe(304);
      expect(
        (await fetch(`${origin}/weak-tag.txt`, { headers: { "if-none-match": '"release-weak"' } }))
          .status,
      ).toBe(304);
      expect(
        (
          await fetch(`${origin}/weak-tag.txt`, {
            headers: { range: "bytes=8-", "if-range": 'W/"release-weak"' },
          })
        ).status,
      ).toBe(200);
      const head = await fetch(`${origin}/asset.txt`, { method: "HEAD" });
      expect(head.status).toBe(200);
      expect(await head.text()).toBe("");
      expect(await (await fetch(`${origin}/copy`)).text()).toBe("fixture asset");
      expect(await (await fetch(`${origin}/loop`)).text()).toBe("same asset");
      const redirect = await fetch(`${origin}/old`, { redirect: "manual" });
      expect(redirect.status).toBe(302);
      expect(redirect.headers.get("location")).toBe(`${origin}/about/`);
      expect(await (await fetch(`${origin}/about`)).text()).toBe("<p>about</p>");
    });

    it("serves rewrite targets once without redirecting the original URL", async () => {
      for (const path of ["/rewritten", "/rewritten-clean"]) {
        const response = await fetch(`${origin}${path}`, { redirect: "manual" });
        expect(response.status).toBe(200);
        expect(response.headers.has("location")).toBe(false);
        expect(await response.text()).toBe("<p>about</p>");
      }

      for (const path of ["/client/route", "/index.html"]) {
        const response = await fetch(`${origin}/fixture/spa${path}`, {
          redirect: "manual",
        });

        expect(response.status).toBe(200);
        expect(response.headers.has("location")).toBe(false);
        expect(await response.text()).toBe("<p>home</p>");
      }

      const direct = await fetch(`${origin}/static/index.html`, { redirect: "manual" });
      expect(direct.status).toBe(307);
      expect(direct.headers.get("location")).toBe(`${origin}/static/`);
    });

    it("attributes console errors through a trusted tail without exposing ingestion credentials", async () => {
      await call("log");
      await vi.waitFor(
        () => {
          expect(
            telemetryRecords.some(
              (record) =>
                record.authorization === "Bearer fixture-telemetry-only" &&
                record.body.includes("fixture console error"),
            ),
          ).toBe(true);
        },
        { timeout: 10000 },
      );

      const messages = telemetryRecords.flatMap((record) =>
        z
          .object({
            resourceLogs: z.array(
              z.object({
                scopeLogs: z.array(
                  z.object({
                    logRecords: z.array(z.object({ body: z.object({ stringValue: z.string() }) })),
                  }),
                ),
              }),
            ),
          })
          .parse(JSON.parse(record.body))
          .resourceLogs.flatMap((resource) =>
            resource.scopeLogs.flatMap((scope) =>
              scope.logRecords.map((log) => z.json().parse(JSON.parse(log.body.stringValue))),
            ),
          ),
      );

      expect(messages).toContainEqual({
        widefleet: 1,
        source: "server",
        kind: "log",
        message: "fixture console error",
        buildId: "fixture-current-build",
        deploymentId,
      });
      expect(messages).toContainEqual({
        widefleet: 1,
        source: "browser",
        kind: "error",
        message: "fixture older browser error",
        buildId: "fixture-older-build",
        deploymentId: null,
      });
      const environment = await call("env");
      expect(environment).not.toContain("WIDEFLEET_CONTROL_TOKEN");
      expect(JSON.stringify(environment)).not.toContain("telemetry");
    });

    it("releases old dynamic workers across more versions than celld's process limit", async () => {
      for (let index = 0; index < 270; index++) {
        expect((await fetch(`${origin}/fixture/version`)).status).toBe(204);
        expect((await fetch(`${origin}/.well-known/widefleet/ready`)).status).toBe(200);
      }

      expect(await call("env")).toContain("DB");
    }, 120000);

    it("retains D1 prepared statements, transactions, raw rows and session bookmarks", async () => {
      expect(await call("database")).toMatchObject({
        value: 42,
        rows: [["value"], [42]],
        bookmark: "celld:primary",
        rolledBack: true,
      });
    });

    it("retains R2 streaming bodies, metadata, conditions, ranges and multipart uploads", async () => {
      expect(await call("objects")).toMatchObject({
        text: "fixture body",
        contentType: "text/plain",
        key: "照片/Grüße",
        metadata: { kind: "照片" },
        range: "fixture",
        conditionHasBody: false,
        upload: "part",
        missing: null,
        bytes: 5 * 1024 * 1024,
      });
    });

    it("retains KV JSON, metadata, bytes, streams, bulk reads and listing", async () => {
      expect(await call("kv")).toMatchObject({
        value: { value: { ok: true }, metadata: { kind: "fixture" } },
        bytes: [0, 128, 255],
        text: "stream",
        unicode: { value: "Grüße", metadata: { label: "客户" }, cacheStatus: null },
        empty: "",
        deleted: null,
        bulk: [
          ["stream", "stream"],
          ["delete", null],
          ["__proto__", "ordinary key"],
        ],
        bulkJson: [
          ["json", { value: { ok: true }, metadata: { kind: "fixture" } }],
          ["delete", { value: null, metadata: null }],
        ],
        count: 3,
      });
    });

    it("rejects oversized incoming KV streams before the sender finishes uploading", async () => {
      const request = httpRequest(`${origin}/?operation=kv-stream-limit`, { method: "POST" });

      try {
        const incoming = once(request, "response");
        // Exceed native KV's 25 MiB limit without ending the upload. The
        // response must arrive without EOF; buffering the input would hang.
        request.write(Buffer.alloc(32 * 1024 * 1024));
        const [parsed] = z.tuple([z.instanceof(IncomingMessage)]).parse(await incoming);
        parsed.setEncoding("utf8");
        let body = "";

        for await (const chunk of parsed) body += z.string().parse(chunk);
        const result = z.object({ error: z.string(), stored: z.null() }).parse(JSON.parse(body));
        expect(result.error).toContain("stream is larger");
      } finally {
        request.destroy();
      }
    });

    it("delivers native cron and queue events, preserves waitUntil and retry decisions", async () => {
      await call("enqueue");
      await expect
        .poll(() => call("queue-result"), { timeout: 20000 })
        .toMatchObject({
          implicit: true,
          retried: true,
          dead: true,
          settled: true,
          background: true,
        });
      await expect.poll(() => call("cron-result"), { timeout: 70000 }).toBe(true);
      await stop();
      await start();
      expect(await call("queue-result")).toMatchObject({ background: true, settled: true });
      expect(await call("database-read")).toEqual(42);
    }, 95000);
  },
);
