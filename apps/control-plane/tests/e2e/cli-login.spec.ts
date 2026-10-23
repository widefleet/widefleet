import { expect, test as base } from "@playwright/test";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createProxy, request as httpRequest } from "node:http";
import { createServer as createTlsServer } from "node:https";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { cliCallbackUrl } from "../../src/lib/server/cli-login.ts";
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
      "_widefleet.cloud.test.": `url=${cloudOrigin}`,
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

for (const destination of ["cloud", "company"] as const) {
  test(`opens one link, signs in and approves at ${destination} before the CLI resumes`, async ({
    page,
  }) => {
    const cloud = fixtures.find(({ origin }) => origin === cloudOrigin);

    const target = fixtures.find(
      ({ origin }) => origin === (destination === "cloud" ? cloudOrigin : companyOrigin),
    );

    if (!cloud || !target) throw new Error("Missing local fixtures");
    const email = `${crypto.randomUUID()}@${destination}.test`;
    const person = target.environment.users.createUser({ email });
    await target.environment.users.saveUser(person);
    await target.environment.linkMicrosoftUser(person.id);
    const verifier = randomBytes(32).toString("base64url");
    const pollToken = randomBytes(32).toString("base64url");

    const started = await cloud.environment.cliLogin.start({
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      poll_hash: createHash("sha256").update(pollToken).digest("hex"),
      scope: "openid profile offline_access platform:read platform:write",
    });

    await page.goto(started.verification_uri);
    await page.getByLabel("Email", { exact: true }).fill(email);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`^${target.origin.replaceAll(".", "\\.")}/sign-in\\?`));
    await expect(page.getByLabel("Email", { exact: true })).toHaveValue(email);

    if (destination === "cloud") {
      await page.getByLabel("Email", { exact: true }).fill("employee@company.test");
      await page.getByRole("button", { name: "Continue", exact: true }).click();
      await expect(page.getByRole("alert")).toContainText("widefleet login --domain company.test");
      await expect(page).toHaveURL(new RegExp(`^${cloudOrigin.replaceAll(".", "\\.")}/sign-in\\?`));
      await page.getByLabel("Email", { exact: true }).fill(email);
    }

    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect
      .poll(
        () =>
          target.logs
            .split(`Widefleet sign-in code for ${email}:`)
            .at(-1)
            ?.match(/code is (\d{6})/)?.[1],
      )
      .toBeTruthy();

    const code = z.string().parse(
      target.logs
        .split(`Widefleet sign-in code for ${email}:`)
        .at(-1)
        ?.match(/code is (\d{6})/)?.[1],
    );

    await page.getByLabel("Sign-in code", { exact: true }).fill(code);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`^${target.origin.replaceAll(".", "\\.")}/device\\?`));
    await expect(page.getByText(started.user_code, { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Authorize CLI", exact: true })).toBeDisabled();
    await page.getByLabel("I started this request on my device and verified the code.").check();
    await page.getByRole("button", { name: "Authorize CLI", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Sign-in approved", exact: true }),
    ).toBeVisible();
    await expect(page).toHaveURL(`${cloudOrigin}/cli-login/done?status=authorized`);
    const result = await cloud.environment.cliLogin.poll(started.request_id, pollToken);
    expect(result.status).toBe("authorized");
    expect(result.platform_url).toBe(target.origin);

    const exchanged = await target.environment.auth.handler(
      new Request(`${target.origin}/api/auth/oauth2/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: "platform-cli",
          redirect_uri: cliCallbackUrl,
          code: z.string().parse(result.code),
          code_verifier: verifier,
        }),
      }),
    );

    expect(exchanged.status, await exchanged.clone().text()).toBe(200);
    const tokens = z.object({ access_token: z.string() }).parse(await exchanged.json());

    const context = await fetch(
      `${target.local}/api/cli-login/context?request=${started.request_id}`,
      {
        headers: {
          "x-forwarded-proto": "https",
          "x-forwarded-host": new URL(target.origin).host,
          authorization: `Bearer ${tokens.access_token}`,
        },
      },
    );

    expect(context.status, await context.clone().text()).toBe(200);
    expect(await context.json()).toMatchObject({ organization_id: "widefleet" });

    if (destination === "company") {
      expect(
        requests.filter(
          ({ origin, path }) => origin === cloudOrigin && path.startsWith("/api/auth/"),
        ),
      ).toEqual([]);
    }
  });
}
