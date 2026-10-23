import { expect, test as base } from "@playwright/test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createProxy, request as httpRequest } from "node:http";
import { createServer as createTlsServer } from "node:https";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { createTestEnvironment } from "../environment.ts";
import { createCertificates } from "../installation/certificates.ts";
import { organizationSettings } from "../../src/lib/server/schema.ts";

const cloudOrigin = "https://app.widefleet.com";

const companyOrigin = "https://platform.example.test";

const fixtures: {
  origin: string;
  local: string;
  environment: Awaited<ReturnType<typeof createTestEnvironment>>;
  server: ReturnType<typeof spawn>;
  logs: string;
}[] = [];

let directory: string;

const requests: { origin: string; path: string }[] = [];

let proxyUrl: string;

let tlsServer: ReturnType<typeof createTlsServer>;

const proxy = createProxy();

const sockets = new Set<Socket>();

const track = (socket: Socket) => {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
};

const test = base.extend({
  page: async ({ browser }, use) => {
    const context = await browser.newContext({
      proxy: { server: proxyUrl },
      ignoreHTTPSErrors: true,
    });

    await use(await context.newPage());
    await context.close();
  },
});

test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "widefleet-cli-browser-"));
  const records = join(directory, "dns.json");
  await writeFile(
    records,
    JSON.stringify({
      "_widefleet.company.test.": `url=${companyOrigin}`,
    }),
  );

  for (const [origin, port] of [
    [cloudOrigin, 25431],
    [companyOrigin, 25433],
  ] as const) {
    const environment = await createTestEnvironment(origin);
    await environment.database.db.update(organizationSettings).set({ ssoRequired: false });

    const server = spawn(
      process.execPath,
      ["--import", fileURLToPath(new URL("./dns.fixture.ts", import.meta.url)), "build"],
      {
        cwd: fileURLToPath(new URL("../../", import.meta.url)),
        env: {
          ...process.env,
          ...environment.environment,
          WIDEFLEET_TEST_DNS_FILE: records,
          WIDEFLEET_TELEMETRY_DISABLED: "1",
          LOGIN_CODE_DELIVERY: "console",
          NODE_ENV: "production",
          HOST: "127.0.0.1",
          PORT: String(port),
          PROTOCOL_HEADER: "x-forwarded-proto",
          HOST_HEADER: "x-forwarded-host",
          SHUTDOWN_TIMEOUT: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    const fixture = { origin, local: `http://127.0.0.1:${port}`, environment, server, logs: "" };
    fixtures.push(fixture);
    server.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      fixture.logs += chunk;
    });
    server.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      fixture.logs += chunk;
    });
    await expect
      .poll(
        async () => {
          if (server.exitCode !== null) throw new Error(fixture.logs);

          try {
            return (
              await fetch(`${fixture.local}/healthz`, {
                headers: { "x-forwarded-proto": "https", "x-forwarded-host": new URL(origin).host },
              })
            ).ok;
          } catch {
            return false;
          }
        },
        { timeout: 15_000 },
      )
      .toBe(true);
  }

  const certificates = await createCertificates(directory, [
    "app.widefleet.com",
    "platform.example.test",
  ]);

  tlsServer = createTlsServer(
    { key: await readFile(certificates.key), cert: await readFile(certificates.certificate) },
    (request, response) => {
      const fixture = fixtures.find(({ origin }) => new URL(origin).host === request.headers.host);

      if (!fixture) {
        response.writeHead(403).end();

        return;
      }

      requests.push({
        origin: fixture.origin,
        path: new URL(request.url ?? "/", fixture.origin).pathname,
      });

      const upstream = httpRequest(
        `${fixture.local}${request.url ?? "/"}`,
        {
          method: request.method,
          headers: {
            ...request.headers,
            "x-forwarded-proto": "https",
            "x-forwarded-host": new URL(fixture.origin).host,
          },
        },
        (incoming) => {
          response.writeHead(incoming.statusCode ?? 502, incoming.headers);
          incoming.pipe(response);
        },
      );

      upstream.on("error", () => response.writeHead(502).end());
      request.pipe(upstream);
    },
  );
  tlsServer.on("connection", track);
  tlsServer.listen(0, "127.0.0.1");
  await once(tlsServer, "listening");
  const tlsPort = z.object({ port: z.number() }).parse(tlsServer.address()).port;
  proxy.on("connection", track);
  proxy.on("connect", (request, downstream, head) => {
    // Every redirect traverses this proxy. Unknown hosts cannot reach the network.
    if (!["app.widefleet.com:443", "platform.example.test:443"].includes(request.url ?? "")) {
      downstream.end("HTTP/1.1 403 Forbidden\r\n\r\n");

      return;
    }

    const upstream = connect(tlsPort, "127.0.0.1", () => {
      downstream.write("HTTP/1.1 200 Connection Established\r\n\r\n");

      if (head.length) upstream.write(head);
      downstream.pipe(upstream).pipe(downstream);
    });

    track(upstream);
    upstream.on("error", () => downstream.destroy());
    downstream.on("error", () => upstream.destroy());
    downstream.on("close", () => upstream.destroy());
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  proxyUrl = `http://127.0.0.1:${z.object({ port: z.number() }).parse(proxy.address()).port}`;
});

test.afterAll(async () => {
  for (const socket of sockets) socket.destroy();

  if (tlsServer) await new Promise<void>((resolve) => tlsServer.close(() => resolve()));
  await new Promise<void>((resolve) => proxy.close(() => resolve()));

  for (const fixture of fixtures) {
    if (fixture.server.exitCode === null) {
      const exited = once(fixture.server, "exit");
      const timeout = setTimeout(() => fixture.server.kill("SIGKILL"), 5000);
      fixture.server.kill("SIGTERM");
      await exited;
      clearTimeout(timeout);
    }

    await fixture.environment.close();
  }

  if (directory) await rm(directory, { recursive: true, force: true });
});

test.beforeEach(() => {
  requests.length = 0;
});

test.afterEach(async ({ browserName }, info) => {
  if (info.status !== info.expectedStatus)
    for (const fixture of fixtures)
      await info.attach(`${browserName}-${new URL(fixture.origin).host}-server-log`, {
        body: fixture.logs,
        contentType: "text/plain",
      });
});

for (const mode of [
  "automatic-cloud",
  "automatic-company",
  "explicit-cloud",
  "saved-company",
] as const) {
  test(`running CLI completes device authorization for ${mode}`, async ({ page }) => {
    const isCloud = mode.endsWith("cloud");
    const automatic = mode.startsWith("automatic");

    const target = fixtures.find(
      ({ origin }) => origin === (isCloud ? cloudOrigin : companyOrigin),
    );

    if (!target) throw new Error("Missing local fixture");
    // The explicit Cloud case uses a company email that would otherwise redirect.
    const email = `${crypto.randomUUID()}@${mode === "automatic-cloud" ? "cloud" : "company"}.test`;
    const person = target.environment.users.createUser({ email });
    await target.environment.users.saveUser(person);
    await target.environment.linkMicrosoftUser(person.id);
    const config = join(directory, `${mode}.json`);

    if (mode === "saved-company")
      await writeFile(config, JSON.stringify({ platform_url: companyOrigin }));

    const child = spawn(
      fileURLToPath(new URL("../../../../target/debug/widefleet", import.meta.url)),
      mode === "explicit-cloud" ? ["--url", cloudOrigin, "login"] : ["login"],
      {
        env: {
          ...process.env,
          PLATFORM_URL: undefined,
          PLATFORM_ORGANIZATION: undefined,
          PLATFORM_CONFIG_FILE: config,
          PLATFORM_SESSION_FILE: join(directory, mode, "session.json"),
          PLATFORM_ACCESS_TOKEN: "synthetic-environment-token-must-not-be-used",
          WIDEFLEET_TELEMETRY_DISABLED: "1",
          SSL_CERT_FILE: join(directory, "ca.pem"),
          HTTPS_PROXY: proxyUrl,
          https_proxy: proxyUrl,
          HTTP_PROXY: proxyUrl,
          http_proxy: proxyUrl,
          ALL_PROXY: undefined,
          all_proxy: undefined,
          NO_PROXY: "",
          no_proxy: "",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let output = "";
    let errors = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      output += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      errors += chunk;
    });
    const exited = once(child, "exit");

    try {
      await expect
        .poll(() => {
          if (child.exitCode !== null) throw new Error(errors);

          return output.match(/Open (https:\/\/\S+)/)?.[1];
        })
        .toBeTruthy();
      const link = z.string().parse(output.match(/Open (https:\/\/\S+)/)?.[1]);
      await page.goto(link);

      if (automatic) {
        await page.getByLabel("Email", { exact: true }).fill(email);
        await page.getByRole("button", { name: "Continue", exact: true }).click();
      }

      await expect(page).toHaveURL(
        new RegExp(`^${target.origin.replaceAll(".", "\\.")}/sign-in\\?`),
      );

      if (automatic) await expect(page.getByLabel("Email", { exact: true })).toHaveValue(email);
      await page.getByLabel("Email", { exact: true }).fill(email);
      await page.getByRole("button", { name: "Continue", exact: true }).click();
      await expect
        .poll(
          () =>
            target.logs
              .split(`Widefleet sign-in code for ${email}:`)
              .slice(1)
              .at(-1)
              ?.match(/code is (\d{6})/)?.[1],
        )
        .toBeTruthy();

      const otp = z.string().parse(
        target.logs
          .split(`Widefleet sign-in code for ${email}:`)
          .slice(1)
          .at(-1)
          ?.match(/code is (\d{6})/)?.[1],
      );

      await page.getByLabel("Sign-in code", { exact: true }).fill(otp);
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await expect(page).toHaveURL(
        new RegExp(`^${target.origin.replaceAll(".", "\\.")}/device\\?`),
      );
      const userCode = await page.getByLabel("Device code", { exact: true }).inputValue();
      expect(output).toContain(`verify code: ${userCode}`);
      await page.getByRole("button", { name: "Check code", exact: true }).click();
      await expect(page.getByRole("button", { name: "Authorize CLI", exact: true })).toBeDisabled();
      await page.getByLabel("I started this request on my device and verified the code.").check();
      await page.getByRole("button", { name: "Authorize CLI", exact: true }).click();
      await expect(page.getByText("CLI connected. You can close this window.")).toBeVisible();
      await expect.poll(() => child.exitCode).toBe(0);
      expect(JSON.parse(await readFile(config, "utf8"))).toEqual({ platform_url: target.origin });
      expect(
        requests
          .filter(
            ({ path }) => path === "/api/auth/device/code" || path === "/api/auth/oauth2/token",
          )
          .every(({ origin }) => origin === target.origin),
      ).toBe(true);
      expect(requests.some(({ path }) => path === "/api/auth/oauth2/authorize")).toBe(false);

      if (!automatic)
        expect(requests.some(({ path }) => path.startsWith("/api/auth/cli-login/"))).toBe(false);
    } finally {
      if (child.exitCode === null) child.kill("SIGTERM");
      await exited;
    }
  });
}
