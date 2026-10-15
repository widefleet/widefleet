import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { copyFile, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { authControlPath } from "@platform/auth-proxy/publication";
import { activationStatus } from "@platform/contracts";
import { authBundle } from "../src/lib/server/auth-bundle.ts";
import { readOptionalFile, writePrivateFile } from "../src/lib/server/installation-files.ts";

const configuration = z
  .object({
    PLATFORM_AUTH_DIRECTORY: z.string().default("/auth"),
    PROXY_RUNTIME_DIRECTORY: z.string().default("/runtime"),
    AUTH_PROXY_WORKER: z.string().default("/worker.js"),
    CELLD_BINARY: z.string().default("/usr/local/bin/celld"),
    CELLD_BUCKET: z.string().min(1),
  })
  .parse(process.env);

const directory = configuration.PLATFORM_AUTH_DIRECTORY;

const runtime = configuration.PROXY_RUNTIME_DIRECTORY;

let stopped = false;

let child: ChildProcess | null = null;

const status = (
  revision: string,
  state: "waiting" | "applying" | "active" | "failed",
  message: string,
) => writePrivateFile(join(directory, "status.json"), JSON.stringify({ revision, state, message }));

const stop = async () => {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const timeout = setTimeout(() => child?.kill("SIGKILL"), 40_000);

  try {
    await exited;
  } finally {
    clearTimeout(timeout);
  }
};

for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.once(signal, () => {
    stopped = true;
  });

await mkdir(runtime, { recursive: true, mode: 0o700 });

const tokenPath = join(directory, "control-token");

const existingKey = await readOptionalFile(tokenPath);

const key =
  existingKey === null
    ? randomBytes(32).toString("base64url")
    : z.string().min(32).parse(existingKey.trim());

if (existingKey === null) await writePrivateFile(tokenPath, key);

await copyFile(configuration.AUTH_PROXY_WORKER, join(runtime, "worker.js"));

await writePrivateFile(
  join(runtime, "wrangler.json"),
  JSON.stringify({
    name: "widefleet-auth-proxy",
    main: "worker.js",
    no_bundle: true,
    compatibility_date: "2026-10-01",
    compatibility_flags: ["nodejs_compat"],
    vars: { AUTH_PROXY_KEY: key },
    kv_namespaces: [{ binding: "AUTH_CONFIG", id: "widefleet-auth" }],
  }),
);

const request = (method: string, body?: string) =>
  fetch(`http://127.0.0.1:4180${authControlPath}/configuration`, {
    method,
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: body ?? null,
    signal: AbortSignal.timeout(15_000),
  });

try {
  // celld keeps the KV namespace in fleet storage across code updates and container restarts.
  const deployment = spawn(configuration.CELLD_BINARY, ["deploy", runtime], { stdio: "inherit" });

  const [exitCode] = z
    .tuple([z.number().nullable(), z.string().nullable()])
    .parse(await once(deployment, "exit"));

  if (exitCode !== 0) throw new Error("Auth proxy deployment failed");
  child = spawn(
    configuration.CELLD_BINARY,
    [
      "--listen",
      "0.0.0.0:4180",
      "--internal-listen",
      "127.0.0.1:4182",
      "--advertise",
      "127.0.0.1:4182",
      "--trust-forwarded-headers",
    ],
    { env: { ...process.env, CELLD_WATCH: join(runtime, "cache") }, stdio: "inherit" },
  );
  let ready = false;

  for (let attempt = 0; attempt < 120 && !stopped; attempt++) {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error("Auth proxy runtime stopped");

    try {
      const response = await request("GET");

      if (response.ok) {
        const current = activationStatus.parse(await response.json());
        await status(current.revision, current.state, current.message);
        ready = true;
        break;
      }

      await response.body?.cancel();
    } catch {
      /* Wait for celld's listener and persisted KV namespace. */
    }

    await delay(250);
  }

  if (!ready && !stopped) throw new Error("Auth proxy runtime did not become ready");

  let attempted = "";

  while (!stopped) {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error("Auth proxy runtime stopped");
    const path = join(directory, "desired.json");
    const desired = await readOptionalFile(path);

    if (desired) {
      const candidate = `${(await stat(path)).mtimeMs}:${desired}`;

      if (candidate !== attempted) {
        attempted = candidate;
        const bundle = authBundle.safeParse(JSON.parse(desired));

        if (!bundle.success) {
          await status(
            "",
            "failed",
            "Invalid sign-in configuration. Save the installation settings again.",
          );
        } else {
          await status(bundle.data.revision, "applying", "Applying the sign-in configuration");

          try {
            const response = await request("PUT", JSON.stringify(bundle.data.configuration));

            if (!response.ok) throw new Error("Auth configuration publication failed");
            await status(
              bundle.data.revision,
              "active",
              "The auth proxy is using the saved configuration",
            );
          } catch {
            await status(
              bundle.data.revision,
              "failed",
              "The auth proxy could not apply the configuration. Check the SSO container and apply again.",
            );
          }
        }
      }
    }

    await delay(1000);
  }
} finally {
  await stop();
}
