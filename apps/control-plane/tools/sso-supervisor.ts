import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { authBundle } from "../src/lib/server/auth-bundle.ts";
import { startAppAuthorizer } from "./app-authorizer.ts";
import { readOptionalFile, writePrivateFile } from "../src/lib/server/installation-files.ts";
import { ssoFailureReason } from "./sso-diagnostics.ts";

type Bundle = z.infer<typeof authBundle>;

const configuration = z
  .object({
    PLATFORM_AUTH_DIRECTORY: z.string().default("/auth"),
    PROXY_RUNTIME_DIRECTORY: z.string().default("/runtime"),
    OAUTH2_PROXY_BINARY: z.string().default("/bin/oauth2-proxy"),
    OAUTH2_PROXY_OPTIONS: z.string().default("/config/options.cfg"),
  })
  .parse(process.env);

const directory = configuration.PLATFORM_AUTH_DIRECTORY;

const runtime = configuration.PROXY_RUNTIME_DIRECTORY;

let stopped = false;

let child: ChildProcess | null = null;

let active: Bundle | null = null;

const authorizer = startAppAuthorizer(() => {
  const proxy = z
    .object({
      providers: z.array(z.object({ oidcConfig: z.object({ issuerURL: z.string() }) })).length(1),
    })
    .safeParse(active?.proxy);

  return proxy.success ? (proxy.data.providers[0]?.oidcConfig.issuerURL ?? null) : null;
});

let attempted = "";

let rejected: { revision: string; reason: string } | null = null;

const status = (
  revision: string,
  state: "waiting" | "applying" | "active" | "failed",
  message: string,
) => writePrivateFile(join(directory, "status.json"), JSON.stringify({ revision, state, message }));

const stop = async () => {
  const current = child;
  child = null;

  if (!current?.pid || current.exitCode !== null || current.signalCode !== null) return;
  const exited = once(current, "exit");
  current.kill("SIGTERM");
  const timeout = setTimeout(() => current.kill("SIGKILL"), 5000);
  await exited;
  clearTimeout(timeout);
};

const options = (bundle: Bundle, alpha: string) => [
  `--config=${configuration.OAUTH2_PROXY_OPTIONS}`,
  `--alpha-config=${alpha}`,
  `--cookie-domain=.${bundle.domain}`,
  `--whitelist-domain=.${bundle.domain}`,
  `--redirect-url=${bundle.redirectUrl}`,
];

const launch = (bundle: Bundle, args: string[], quiet: boolean) => {
  const subprocess = spawn(configuration.OAUTH2_PROXY_BINARY, args, {
    env: { ...process.env, OAUTH2_PROXY_COOKIE_SECRET: bundle.cookieSecret },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  let spawnFailed = false;

  subprocess.once("error", () => {
    spawnFailed = true;
  });

  for (const [source, destination] of [
    [subprocess.stdout, process.stdout],
    [subprocess.stderr, process.stderr],
  ] as const) {
    if (!quiet) source.pipe(destination, { end: false });
    source.setEncoding("utf8").on("data", (chunk: string) => {
      // Retain only a bounded tail; raw output never enters status.json.
      output = (output + chunk).slice(-16_384);
    });
  }

  // Waiting for close also drains the diagnostic pipes, including on spawn failure.
  const closed = new Promise<number | null>((resolve) => subprocess.once("close", resolve));

  return {
    process: subprocess,
    closed,
    failed: () => spawnFailed,
    reason: (phase: "validation" | "startup") =>
      spawnFailed
        ? "The sign-in service executable could not be started. Check the SSO image and runtime permissions."
        : ssoFailureReason(output, phase),
  };
};

const prepare = async (bundle: Bundle) => {
  const path = join(runtime, "alpha.json");

  const proxy = z
    .object({ providers: z.array(z.object({ clientSecretFile: z.string() }).passthrough()) })
    .passthrough()
    .parse(bundle.proxy);

  for (const provider of proxy.providers)
    provider.clientSecretFile = join(runtime, "client-secret");
  await writePrivateFile(join(runtime, "client-secret"), bundle.clientSecret);
  await writePrivateFile(path, JSON.stringify(proxy));

  return path;
};

const validate = async (bundle: Bundle) => {
  const candidateDirectory = join(runtime, "candidate");
  await mkdir(candidateDirectory, { recursive: true, mode: 0o700 });
  const secret = join(candidateDirectory, "client-secret");

  const proxy = z
    .object({ providers: z.array(z.object({ clientSecretFile: z.string() }).passthrough()) })
    .passthrough()
    .parse(bundle.proxy);

  for (const provider of proxy.providers) provider.clientSecretFile = secret;
  const alpha = join(candidateDirectory, "alpha.json");
  await writePrivateFile(secret, bundle.clientSecret);
  await writePrivateFile(alpha, JSON.stringify(proxy));
  const validation = launch(bundle, [...options(bundle, alpha), "--config-test"], true);
  let timedOut = false;

  const timeout = setTimeout(() => {
    timedOut = true;
    validation.process.kill("SIGKILL");
  }, 30_000);

  try {
    const code = await validation.closed;

    if (timedOut)
      return "Sign-in configuration validation timed out. Check the SSO container logs and available resources, then save again.";

    return code === 0 ? null : validation.reason("validation");
  } finally {
    clearTimeout(timeout);
  }
};

const start = async (bundle: Bundle) => {
  const alpha = await prepare(bundle);
  const launched = launch(bundle, options(bundle, alpha), false);
  child = launched.process;

  for (let attempt = 0; attempt < 80 && !stopped; attempt++) {
    if (
      launched.failed() ||
      launched.process.exitCode !== null ||
      launched.process.signalCode !== null
    )
      break;

    try {
      const response = await fetch("http://127.0.0.1:4180/ready", {
        signal: AbortSignal.timeout(500),
      });

      if (response.ok) return null;
    } catch {
      /* The listener is still starting. */
    }

    await delay(100);
  }

  await stop();
  await launched.closed;

  return launched.reason("startup");
};

const isRunning = () => child !== null && child.exitCode === null && child.signalCode === null;

const failureStatus = (revision: string, reason: string) =>
  status(
    revision,
    "failed",
    `${reason} ${
      isRunning()
        ? "The previous configuration is running."
        : active
          ? "App sign-in is unavailable; the previous configuration is saved for retry."
          : "App sign-in is unavailable; no configuration has been activated."
    }`,
  );

const proxyOptions = (bundle: Bundle) =>
  JSON.stringify([bundle.proxy, bundle.domain, bundle.redirectUrl, bundle.cookieSecret]);

const apply = async (bundle: Bundle) => {
  await status(bundle.revision, "applying", "Applying the sign-in configuration");

  const validationFailure = await validate(bundle);

  if (validationFailure) {
    rejected = { revision: bundle.revision, reason: validationFailure };
    await failureStatus(rejected.revision, rejected.reason);

    return;
  }

  const running = child && child.exitCode === null && child.signalCode === null;

  if (running && active && proxyOptions(active) === proxyOptions(bundle)) {
    await prepare(bundle);
  } else {
    await stop();

    const startupFailure = await start(bundle);

    if (startupFailure) {
      if (active && !stopped) await start(active);
      rejected = { revision: bundle.revision, reason: startupFailure };
      await failureStatus(rejected.revision, rejected.reason);

      return;
    }
  }

  active = bundle;
  rejected = null;
  await writePrivateFile(join(directory, "active.json"), JSON.stringify(bundle));
  await status(
    bundle.revision,
    "active",
    "The sign-in service is running with the saved configuration",
  );
};

const retry = async () => {
  if (!active || isRunning()) return;
  const startupFailure = await start(active);

  // Keep a rejected desired revision visible while retrying the last working one.
  if (rejected) await failureStatus(rejected.revision, rejected.reason);
  else if (startupFailure) await failureStatus(active.revision, startupFailure);
  else
    await status(
      active.revision,
      "active",
      "The sign-in service is running with its persisted configuration",
    );
};

for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.once(signal, () => {
    stopped = true;
  });

try {
  const stored = await readOptionalFile(join(directory, "active.json"));

  if (stored) {
    active = authBundle.parse(JSON.parse(stored));

    const startupFailure = await start(active);

    if (startupFailure) await failureStatus(active.revision, startupFailure);
    else
      await status(
        active.revision,
        "active",
        "The sign-in service is running with its persisted configuration",
      );
  } else await status("", "waiting", "Waiting for company sign-in configuration");

  while (!stopped) {
    const desiredPath = join(directory, "desired.json");
    const desired = await readOptionalFile(desiredPath);

    if (desired) {
      const modified = (await stat(desiredPath)).mtimeMs;
      const key = `${modified}:${desired}`;

      if (key !== attempted) {
        attempted = key;
        const bundle = authBundle.parse(JSON.parse(desired));
        await apply(bundle);
      }
    }

    await retry();
    await delay(1000);
  }
} finally {
  authorizer.close();
  await stop();
}
