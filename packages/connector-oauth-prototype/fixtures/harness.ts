import { spawn } from "node:child_process";
import { lookup } from "node:dns/promises";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { z } from "zod";
import { createProvider } from "./provider.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url).href);

export const startFixture = async (runtime: "celld" | "workerd", hostname = "127.0.0.1") => {
  const { address } = await lookup(hostname, { family: 4 });
  const provider = await createProvider(hostname);
  const directory = await mkdtemp(join(tmpdir(), "connector-oauth-"));
  const reservation = createServer();
  reservation.listen(0, address);
  await once(reservation, "listening");
  const port = z.object({ port: z.number() }).parse(reservation.address()).port;
  await new Promise<void>((resolve, reject) =>
    reservation.close((error) => (error ? reject(error) : resolve())),
  );
  let origin = `http://${hostname}:${port}`;
  const token = crypto.randomUUID();

  const config = {
    name: "connector-oauth-prototype",
    main: "bundle.js",
    no_bundle: true,
    dev: runtime === "workerd" ? { ip: address, port } : undefined,
    compatibility_date: "2026-10-01",
    compatibility_flags: ["nodejs_compat"],
    d1_databases: [{ binding: "DB", database_name: "oauth-demo", database_id: "oauth-demo" }],
    vars: {
      CONNECTOR_ORIGIN: origin,
      PROVIDER_ORIGIN: provider.origin,
      PROVIDER_API_ORIGIN: provider.origin,
      GITHUB_CLIENT_ID: "local-github-client",
      GITHUB_SCOPES: "read:user",
      GITHUB_CLIENT_SECRET: "local-github-secret",
      AUTH_SECRET: crypto.randomUUID() + crypto.randomUUID(),
      DEMO_COOKIE_KEY: crypto.randomUUID(),
      FIXTURE_TOKEN: token,
    },
  };

  const configPath = join(directory, "wrangler.json");
  let stop = async () => {};

  let reload = async () => {};

  let debug = () => {};

  try {
    await build({
      entryPoints: [fileURLToPath(new URL("./worker.ts", import.meta.url).href)],
      outfile: join(directory, "bundle.js"),
      bundle: true,
      format: "esm",
      platform: "neutral",
      mainFields: ["module", "main"],
      conditions: ["workerd", "worker", "browser"],
      external: ["cloudflare:*", "node:*"],
      loader: { ".sql": "text" },
      logLevel: "silent",
    });
    await writeFile(configPath, JSON.stringify(config));

    if (runtime === "workerd") {
      const { createTestHarness } = await import("wrangler");
      const hosted = createTestHarness({ workers: [{ configPath }] });
      stop = () => hosted.close();
      debug = () => hosted.debug();
      const listening = (await hosted.listen()).url;
      listening.hostname = hostname;
      origin = listening.origin;
      config.vars.CONNECTOR_ORIGIN = origin;
      await writeFile(configPath, JSON.stringify(config));
      reload = () => hosted.update({ workers: [{ configPath }] });
      await reload();
    } else {
      const start = async () => {
        const child = spawn(
          join(root, ".tools/celld"),
          ["dev", directory, "--host", address, "--port", String(port), "--no-watch"],
          {
            stdio: ["ignore", "pipe", "pipe"],
          },
        );

        let output = "";
        debug = () => {
          console.error(output);
        };

        child.stdout.on("data", (data: Buffer) => {
          output += data.toString();
        });
        child.stderr.on("data", (data: Buffer) => {
          output += data.toString();
        });
        stop = async () => {
          if (child.exitCode !== null || child.signalCode !== null) return;
          const exited = once(child, "exit");
          child.kill("SIGTERM");
          await exited;
        };

        for (let attempt = 0; attempt < 100; attempt++) {
          if (child.exitCode !== null) throw new Error(`celld exited: ${output}`);

          try {
            if ((await fetch(`${origin}/.well-known/celld/health`)).ok) return;
          } catch {
            /* The local HTTP listener is still starting. */
          }

          await new Promise((resolve) => setTimeout(resolve, 100));
        }

        throw new Error(`celld did not start: ${output}`);
      };

      reload = async () => {
        await stop();
        await start();
      };

      await start();
    }

    const inspect = (path: string) =>
      fetch(`${origin}/_fixture/${path}`, {
        method: path === "accounts" ? "GET" : "POST",
        headers: { authorization: `Bearer ${token}` },
      });

    provider.setCallbackOrigin(origin);
    const initialized = await inspect("initialize");

    if (!initialized.ok) throw new Error(`Initialization failed: ${await initialized.text()}`);

    return {
      origin,
      provider,
      reload,
      inspect,
      debug,
      close: async () => {
        await stop();
        await provider.close();
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await stop();
    await provider.close();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
};
