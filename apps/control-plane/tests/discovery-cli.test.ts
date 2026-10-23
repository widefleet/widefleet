import { execFile } from "node:child_process";
import { once } from "node:events";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createProxy } from "node:http";
import { createServer } from "node:https";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createCertificates } from "./installation/certificates.ts";
import { createNativeResolver, trustNativeCertificate } from "./fixtures/native-resolver.ts";

const execute = promisify(execFile);

const dnsResponse = (urls: string[], domain: string) => {
  const name = Buffer.concat([
    ...["_widefleet", ...domain.split(".")].map((label) =>
      Buffer.concat([Buffer.from([label.length]), Buffer.from(label)]),
    ),
    Buffer.from([0]),
  ]);

  const header = Buffer.from([0, 1, 0x81, 0x80, 0, 1, 0, urls.length, 0, 0, 0, 0]);

  const records = urls.map((url) => {
    const text = Buffer.from(`url=${url}`);
    const record = Buffer.alloc(12);
    record.writeUInt16BE(0xc00c, 0);
    record.writeUInt16BE(16, 2);
    record.writeUInt16BE(1, 4);
    record.writeUInt32BE(60, 6);
    record.writeUInt16BE(text.length + 1, 10);

    return Buffer.concat([record, Buffer.from([text.length]), text]);
  });

  return Buffer.concat([header, name, Buffer.from([0, 16, 0, 1]), ...records]);
};

describe.runIf(
  process.env["RUN_CLI_TESTS"] === "1" &&
    (process.platform === "linux" || process.env["RUN_CLI_NATIVE_DNS"] === "1"),
)("CLI discovery through native TXT and a local HTTPS proxy", { timeout: 15_000 }, () => {
  let directory: string;
  let nativeResolver: Awaited<ReturnType<typeof createNativeResolver>> | undefined;
  let removeTrust: (() => Promise<void>) | undefined;
  let certificates: Awaited<ReturnType<typeof createCertificates>>;
  let domain = "example.test";
  let dropDnsQueries = false;
  let ca: string;
  let proxyUrl: string;
  let configFile: string;
  let sessionFile: string;
  let dnsLog: string;
  let responseFile: string;
  let httpsStatus = 200;
  let document = "";
  let cloudStatus = 200;
  let cloudOrigin = "https://app.widefleet.com";
  let routeSelected = true;
  let tokenFailure: string | null = null;

  // Unix tests use an isolated session file. Windows has no file-backed store,
  // so successful broker logins must target the reserved synthetic origin.
  const selectedOrigin = () =>
    process.platform === "win32" ? "https://platform.example.test" : cloudOrigin;

  const requestBodies: { host: string; path: string; body: string }[] = [];
  let server: ReturnType<typeof createServer>;
  const proxy = createProxy();
  const sockets = new Set<Socket>();
  const requests: { host: string; path: string; authorization: string | undefined }[] = [];
  const connections: string[] = [];

  const trackSocket = (socket: Socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  };

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "widefleet-discovery-"));

    if (process.platform !== "linux") {
      nativeResolver = await createNativeResolver(directory, async (query) => {
        const labels: string[] = [];
        let offset = 12;

        while (query[offset]) {
          const length = query[offset] ?? 0;

          if (length > 63 || offset + length + 1 >= query.length)
            throw new Error("Unexpected native DNS question encoding");
          labels.push(query.toString("ascii", offset + 1, offset + 1 + length));
          offset += length + 1;
        }

        const name = `${labels.join(".")}.`.toLowerCase();
        const type = query.readUInt16BE(offset + 1);
        const recordClass = query.readUInt16BE(offset + 3);
        const failure = Buffer.from(query.subarray(0, offset + 5));
        failure.writeUInt16BE(0x8182, 2);
        failure.fill(0, 6, 12);

        if (name !== `_widefleet.${domain}.` || type !== 16 || recordClass !== 1) return failure;
        await appendFile(dnsLog, `${name} ${recordClass} ${type}\n`);

        if (dropDnsQueries) return undefined;

        const answer = await readFile(responseFile).catch((cause: unknown) => {
          if (z.object({ code: z.string() }).parse(cause).code === "ENOENT") return failure;
          throw cause;
        });

        query.copy(answer, 0, 0, 2);

        return answer;
      });
    }

    certificates = await createCertificates(directory, [
      nativeResolver ? `*.${nativeResolver.zone}` : "example.test",
      "app.widefleet.com",
    ]);

    ca = certificates.ca;

    if (nativeResolver) removeTrust = await trustNativeCertificate(ca);

    if (process.platform === "linux")
      await execute("cc", [
        "-shared",
        "-fPIC",
        "-Wall",
        "-Wextra",
        "-Werror",
        fileURLToPath(new URL("./fixtures/discovery-resolver.c", import.meta.url)),
        "-o",
        join(directory, "resolver.so"),
      ]);
    server = createServer(
      {
        key: await readFile(certificates.key),
        cert: await readFile(certificates.certificate),
      },
      (request, response) => {
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk: string) => {
          body += chunk;
        });
        request.on("end", () => {
          requestBodies.push({ host: request.headers.host ?? "", path: request.url ?? "", body });
        });
        request.resume();
        requests.push({
          host: request.headers.host ?? "",
          path: request.url ?? "",
          authorization: request.headers.authorization,
        });
        response.setHeader("content-type", "application/json");

        if (request.url?.startsWith("/api/platform-discovery?")) {
          response.writeHead(cloudStatus).end(JSON.stringify({ platform_url: selectedOrigin() }));

          return;
        }

        switch (request.url) {
          case "/api/auth/cli-login/start":
            response.end(
              JSON.stringify({
                request_id: "A".repeat(43),
                cli_token: "B".repeat(43),
                verification_uri: `https://app.widefleet.com/cli-login?request=${"A".repeat(43)}&ticket=${"C".repeat(43)}`,
                expires_in: 60,
                interval: 1,
              }),
            );
            break;
          case "/api/auth/cli-login/poll":
            response.end(JSON.stringify({ platform_url: routeSelected ? selectedOrigin() : null }));
            break;
          case "/api/auth/cli-login/ready":
            response.end(JSON.stringify({ success: true }));
            break;
          case "/.well-known/widefleet":
            response.setHeader("location", "https://unexpected.example.test/");
            response.writeHead(httpsStatus).end(document);
            break;
          case "/api/auth/device/code":
            response.end(
              JSON.stringify({
                device_code: "synthetic-device-code",
                user_code: "TEST-CODE",
                verification_uri: `https://${request.headers.host}/device`,
                expires_in: 60,
                interval: 1,
              }),
            );
            break;
          case "/api/auth/oauth2/token":
            if (tokenFailure) {
              response.writeHead(400).end(JSON.stringify({ error: tokenFailure }));
              break;
            }

            response.end(
              JSON.stringify({
                access_token: "synthetic-access-token",
                refresh_token: "synthetic-refresh-token",
                expires_in: 300,
                token_type: "Bearer",
              }),
            );
            break;
          case "/api/auth/oauth2/revoke":
            response.end("{}");
            break;
          case "/api/v1/me":
            response.end(JSON.stringify({ email: "employee@example.test" }));
            break;
          default:
            response.writeHead(404).end("{}");
        }
      },
    );
    server.on("connection", trackSocket);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = z.object({ port: z.number() }).parse(server.address()).port;
    proxy.on("connection", trackSocket);
    proxy.on("connect", (request, downstream, head) => {
      connections.push(request.url ?? "");

      if (
        ![`${domain}:443`, "platform.example.test:443", "app.widefleet.com:443"].includes(
          request.url ?? "",
        )
      ) {
        downstream.end("HTTP/1.1 403 Forbidden\r\n\r\n");

        return;
      }

      const upstream = connect(port, "127.0.0.1", () => {
        downstream.write("HTTP/1.1 200 Connection Established\r\n\r\n");

        if (head.length) upstream.write(head);
        downstream.pipe(upstream).pipe(downstream);
      });

      trackSocket(upstream);
      upstream.on("error", () => downstream.destroy());
      downstream.on("error", () => upstream.destroy());
      downstream.on("close", () => upstream.destroy());
    });
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
    proxyUrl = `http://127.0.0.1:${z.object({ port: z.number() }).parse(proxy.address()).port}`;
  }, 30_000);

  beforeEach(async () => {
    const id = crypto.randomUUID();
    domain = nativeResolver ? `${id}.${nativeResolver.zone}` : "example.test";
    dropDnsQueries = false;
    configFile = join(directory, `${id}.json`);
    sessionFile = join(directory, id, "session.json");
    dnsLog = join(directory, `${id}.dns.log`);
    responseFile = join(directory, `${id}.dns.bin`);
    await writeFile(dnsLog, "");
    document = JSON.stringify({ platform_url: "https://platform.example.test" });
    httpsStatus = 200;
    cloudStatus = 200;
    cloudOrigin = "https://app.widefleet.com";
    routeSelected = true;
    tokenFailure = null;
    requestBodies.length = 0;
    requests.length = 0;
    connections.length = 0;
  });

  afterEach(async () => {
    if (process.platform !== "win32" || !configFile) return;
    const saved = await readFile(configFile, "utf8").catch(() => "{}");

    if (
      z.object({ platform_url: z.string().optional() }).parse(JSON.parse(saved)).platform_url ===
      "https://platform.example.test"
    )
      await cli(["logout"]);
  });

  afterAll(async () => {
    const results = await Promise.allSettled([removeTrust?.(), nativeResolver?.close()]);

    for (const socket of sockets) socket.destroy();

    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });

    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [z.instanceof(Error).parse(result.reason)] : [],
    );

    if (failures.length)
      throw new AggregateError(failures, "Native discovery fixture cleanup failed");
  }, 30_000);

  const cli = (args: string[], overrides: NodeJS.ProcessEnv = {}) =>
    execute(
      process.env["CLI_BINARY"] ??
        fileURLToPath(
          new URL(
            `../../../target/debug/widefleet${process.platform === "win32" ? ".exe" : ""}`,
            import.meta.url,
          ),
        ),
      args,
      {
        timeout: 12000,
        env: {
          ...process.env,
          PLATFORM_URL: undefined,
          PLATFORM_CONFIG_FILE: configFile,
          PLATFORM_SESSION_FILE: process.platform === "win32" ? undefined : sessionFile,
          PLATFORM_ACCESS_TOKEN: "external-token-must-not-reach-discovery",
          WIDEFLEET_TELEMETRY_DISABLED: "1",
          XDG_STATE_HOME: join(directory, "state"),
          LD_PRELOAD: process.platform === "linux" ? join(directory, "resolver.so") : undefined,
          WIDEFLEET_TEST_DNS_RESPONSE: responseFile,
          WIDEFLEET_TEST_DNS_LOG: dnsLog,
          WIDEFLEET_TEST_DNS_DELAY: undefined,
          SSL_CERT_FILE: ca,
          SSL_CERT_DIR: directory,
          HTTPS_PROXY: proxyUrl,
          https_proxy: proxyUrl,
          HTTP_PROXY: proxyUrl,
          http_proxy: proxyUrl,
          ALL_PROXY: undefined,
          all_proxy: undefined,
          NO_PROXY: "",
          no_proxy: "",
          ...overrides,
        },
      },
    );

  it("uses the native TXT result, saves the URL and avoids further discovery", async () => {
    await writeFile(responseFile, dnsResponse(["https://platform.example.test"], domain));
    await cli(["login", "--email", `private-local-part@${domain}`]);
    const queries = await readFile(dnsLog, "utf8");
    expect(queries).toContain(`_widefleet.${domain}. 1 16\n`);
    expect(requests.map((request) => request.path)).toEqual([
      "/api/auth/device/code",
      "/api/auth/oauth2/token",
    ]);
    expect(JSON.parse(await readFile(configFile, "utf8"))).toEqual({
      platform_url: "https://platform.example.test",
    });
    await cli(["whoami"]);
    expect(await readFile(dnsLog, "utf8")).toBe(queries);
    expect(connections.every((host) => host === "platform.example.test:443")).toBe(true);
  });

  it("discovers in the browser without stdin and uses the selected server's device grant", async () => {
    cloudOrigin = "https://platform.example.test";
    routeSelected = false;
    const running = cli(["login"]);

    try {
      await expect
        .poll(() => requests.some(({ path }) => path === "/api/auth/cli-login/poll"), {
          timeout: 5000,
        })
        .toBe(true);
      expect(requests.some(({ path }) => path === "/api/auth/device/code")).toBe(false);
    } finally {
      routeSelected = true;
      await running;
    }

    const result = await running;
    expect(result.stdout).toContain("https://app.widefleet.com/cli-login?");
    expect(result.stdout).toContain("TEST-CODE");
    expect(JSON.parse(await readFile(configFile, "utf8"))).toEqual({ platform_url: cloudOrigin });
    expect(
      requests
        .filter(({ path }) => path === "/api/auth/device/code" || path === "/api/auth/oauth2/token")
        .every(({ host }) => host === "platform.example.test"),
    ).toBe(true);
    expect(
      requestBodies
        .filter(({ host }) => host === "app.widefleet.com")
        .every(
          ({ body }) =>
            !body.includes("synthetic-device-code") && !body.includes("synthetic-access-token"),
        ),
    ).toBe(true);
    expect(requests.every(({ authorization }) => authorization === undefined)).toBe(true);
  });

  it.each(["flag", "environment", "saved"])(
    "keeps a selfhost supplied by %s fixed",
    async (source) => {
      const origin = "https://platform.example.test";

      if (source === "saved") await writeFile(configFile, JSON.stringify({ platform_url: origin }));
      await cli(
        source === "flag" ? ["--url", origin, "login"] : ["login"],
        source === "environment" ? { PLATFORM_URL: origin } : {},
      );
      expect(requests.map(({ path }) => path)).toEqual([
        "/api/auth/device/code",
        "/api/auth/oauth2/token",
      ]);
      expect(connections.every((host) => host === "platform.example.test:443")).toBe(true);
    },
  );

  it.runIf(process.platform !== "win32").each(["flag", "environment", "saved"])(
    "keeps Cloud supplied by %s fixed",
    async (source) => {
      const origin = "https://app.widefleet.com";

      if (source === "saved") await writeFile(configFile, JSON.stringify({ platform_url: origin }));
      await cli(
        source === "flag" ? ["--url", origin, "login"] : ["login"],
        source === "environment" ? { PLATFORM_URL: origin } : {},
      );
      expect(requests.map(({ path }) => path)).toEqual([
        "/api/auth/device/code",
        "/api/auth/oauth2/token",
      ]);
      expect(connections.every((host) => host === "app.widefleet.com:443")).toBe(true);
    },
  );

  it("does not save a destination when device approval is denied", async () => {
    tokenFailure = "access_denied";
    await expect(cli(["login"])).rejects.toThrow("Device login was denied");
    await expect(readFile(configFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("has no status command that can restore an old destination", async () => {
    await writeFile(
      configFile,
      JSON.stringify({ platform_url: "https://replacement.example.test" }),
    );
    await expect(cli(["login", "--status"])).rejects.toThrow("unexpected argument");
    expect(
      z.object({ platform_url: z.string() }).parse(JSON.parse(await readFile(configFile, "utf8")))
        .platform_url,
    ).toBe("https://replacement.example.test");
    expect(requests).toEqual([]);
  });

  it.runIf(process.platform === "linux")(
    "uses the private credential file automatically without a running keyring",
    async () => {
      cloudOrigin = "https://platform.example.test";

      const overrides = {
        PLATFORM_SESSION_FILE: undefined,
        PLATFORM_ACCESS_TOKEN: undefined,
        DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(directory, "missing-bus")}`,
      };

      const result = await cli(["login"], overrides);
      expect(result.stdout).toContain("widefleet/credentials/");
      expect(JSON.parse((await cli(["whoami"], overrides)).stdout)).toMatchObject({
        email: "employee@example.test",
      });
      await cli(["logout"], overrides);
      await expect(cli(["whoami"], overrides)).rejects.toThrow();
    },
  );

  it.each(["unavailable", "absent"])(
    "uses company HTTPS through the proxy when native DNS is %s",
    async (kind) => {
      if (kind === "absent") await writeFile(responseFile, dnsResponse([], domain));
      const login = await cli(["login", "--email", `private-local-part@${domain}`]);
      // DNSServiceQueryRecord also reports a SERVFAIL response as NoSuchRecord.
      expect(login.stderr).toContain(
        kind === "absent" || process.platform === "darwin"
          ? "No TXT record"
          : "System DNS unavailable",
      );
      expect(requests[0]).toEqual({
        host: domain,
        path: "/.well-known/widefleet",
        authorization: undefined,
      });
      expect(requests.every((request) => request.authorization === undefined)).toBe(true);
      expect(JSON.parse(await readFile(configFile, "utf8"))).toEqual({
        platform_url: "https://platform.example.test",
      });
      expect(await readFile(dnsLog, "utf8")).not.toContain("private-local-part");
      expect(connections).toContain(`${domain}:443`);
    },
  );

  it("falls back after the native deadline and exits without waiting for the resolver thread", async () => {
    dropDnsQueries = true;
    await cli(["login", "--domain", domain], { WIDEFLEET_TEST_DNS_DELAY: "1" });
    expect(await readFile(dnsLog, "utf8")).toContain(`_widefleet.${domain}. 1 16\n`);
    expect(requests[0]?.path).toBe("/.well-known/widefleet");
  }, 12000);

  it("explicit company selection replaces a saved URL only after login succeeds", async () => {
    await writeFile(configFile, JSON.stringify({ platform_url: "https://previous.example.test" }));
    await cli(["login", "--domain", domain]);
    expect(JSON.parse(await readFile(configFile, "utf8"))).toEqual({
      platform_url: "https://platform.example.test",
    });
  });

  it("rejects conflicting DNS records without trying HTTPS or changing configuration", async () => {
    await writeFile(configFile, JSON.stringify({ platform_url: "https://previous.example.test" }));
    await writeFile(
      responseFile,
      dnsResponse(["https://platform.example.test", "https://other.example.test"], domain),
    );
    await expect(cli(["login", "--domain", domain])).rejects.toThrow(
      "Conflicting Widefleet TXT records",
    );
    expect(requests).toEqual([]);
    expect(connections).toEqual([]);
    expect(JSON.parse(await readFile(configFile, "utf8"))).toEqual({
      platform_url: "https://previous.example.test",
    });
  });

  it.each(["<html>Company homepage</html>", '{"platform_url":"http://localhost"}'])(
    "continues in Cloud when the website has no usable discovery document",
    async (body) => {
      document = body;
      const result = await cli(["login", "--domain", domain]);
      expect(result.stdout).toContain("Connected to");
      expect(requests.map(({ path }) => path)).toEqual([
        "/.well-known/widefleet",
        `/api/platform-discovery?domain=${domain}`,
        "/api/auth/device/code",
        "/api/auth/oauth2/token",
      ]);
      expect(requests.every(({ authorization }) => authorization === undefined)).toBe(true);
      expect(
        z.object({ platform_url: z.string() }).parse(JSON.parse(await readFile(configFile, "utf8")))
          .platform_url,
      ).toBe(selectedOrigin());
    },
  );

  it.each([302, 401, 503])(
    "continues in Cloud for website HTTP status %s without following redirects",
    async (status) => {
      httpsStatus = status;
      const result = await cli(["login", "--domain", domain]);
      expect(result.stdout).toContain("Connected to");
      expect(connections).toContain(`${domain}:443`);
      expect(
        connections.every(
          (host) =>
            host === `${domain}:443` ||
            host === "app.widefleet.com:443" ||
            host === "platform.example.test:443",
        ),
      ).toBe(true);
      expect(requests.map(({ path }) => path)).toEqual([
        "/.well-known/widefleet",
        `/api/platform-discovery?domain=${domain}`,
        "/api/auth/device/code",
        "/api/auth/oauth2/token",
      ]);
    },
  );

  it.each([404, 410])(
    "resolves the Cloud entry after local discovery is absent (%s)",
    async (status) => {
      await writeFile(responseFile, dnsResponse([], domain));
      httpsStatus = status;
      await cli(["login", "--email", `employee@${domain}`]);
      expect(requests.map(({ host, path }) => ({ host, path }))).toEqual([
        { host: domain, path: "/.well-known/widefleet" },
        { host: "app.widefleet.com", path: `/api/platform-discovery?domain=${domain}` },
        { host: new URL(selectedOrigin()).host, path: "/api/auth/device/code" },
        { host: new URL(selectedOrigin()).host, path: "/api/auth/oauth2/token" },
      ]);
      expect(requests.every(({ authorization }) => authorization === undefined)).toBe(true);
      expect(JSON.parse(await readFile(configFile, "utf8"))).toEqual({
        platform_url: selectedOrigin(),
      });
      requests.length = 0;
      await cli(["whoami"]);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.host).toBe(new URL(selectedOrigin()).host);
    },
  );

  it("reports an unavailable shared resolver without changing the saved platform", async () => {
    httpsStatus = 404;
    cloudStatus = 503;
    await writeFile(configFile, JSON.stringify({ platform_url: "https://previous.example.test" }));
    await expect(cli(["login", "--domain", domain])).rejects.toThrow();
    expect(requests.every(({ path }) => !path.startsWith("/api/auth/"))).toBe(true);
    expect(JSON.parse(await readFile(configFile, "utf8"))).toEqual({
      platform_url: "https://previous.example.test",
    });
  });

  it("uses the shared Cloud resolver's company result before requesting any device code", async () => {
    await writeFile(responseFile, dnsResponse([], domain));
    httpsStatus = 404;
    cloudOrigin = "https://platform.example.test";
    await cli(["login", "--domain", domain]);
    expect(
      requests.flatMap(({ host, path }) => (path.startsWith("/api/auth/") ? [host] : [])),
    ).toEqual(["platform.example.test", "platform.example.test"]);
    expect(JSON.parse(await readFile(configFile, "utf8"))).toEqual({ platform_url: cloudOrigin });
  });

  it.each([302, 404, 503])(
    "never starts Cloud login when shared discovery returns %s",
    async (status) => {
      await writeFile(responseFile, dnsResponse([], domain));
      httpsStatus = 404;
      cloudStatus = status;
      await expect(cli(["login", "--domain", domain])).rejects.toThrow();
      expect(requests.every(({ path }) => !path.startsWith("/api/auth/"))).toBe(true);
      await expect(readFile(configFile)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("preserves certificate failure details from HTTPS discovery", async () => {
    const untrusted = join(directory, "untrusted");
    await mkdir(untrusted);
    const untrustedCertificates = await createCertificates(untrusted, [domain]);
    server.setSecureContext({
      key: await readFile(untrustedCertificates.key),
      cert: await readFile(untrustedCertificates.certificate),
    });

    try {
      const failure = await cli(["login", "--domain", domain]).then(
        () => null,
        (cause: unknown) => z.object({ stderr: z.string() }).parse(cause),
      );

      expect(failure?.stderr).toContain("Checking Widefleet Cloud");
      expect(failure?.stderr).toContain("HTTP request failed");
      expect(failure?.stderr).toContain("Caused by:");
      expect(failure?.stderr).toMatch(/certificate|issuer/i);
      expect(requests).toEqual([]);
    } finally {
      server.setSecureContext({
        key: await readFile(certificates.key),
        cert: await readFile(certificates.certificate),
      });
    }
  });

  it("preserves proxy connection failures without printing proxy credentials", async () => {
    const refused = createProxy();
    refused.listen(0, "127.0.0.1");
    await once(refused, "listening");
    const port = z.object({ port: z.number() }).parse(refused.address()).port;
    await new Promise<void>((resolve) => refused.close(() => resolve()));
    const proxy = `http://synthetic-proxy-user:synthetic-proxy-secret@127.0.0.1:${port}`;

    const failure = await cli(["login", "--domain", domain], {
      HTTPS_PROXY: proxy,
      https_proxy: proxy,
    }).then(
      () => null,
      (cause: unknown) => z.object({ stderr: z.string() }).parse(cause),
    );

    expect(failure?.stderr).toContain("Checking Widefleet Cloud");
    expect(failure?.stderr).toContain("HTTP request failed");
    expect(failure?.stderr).toContain("Caused by:");
    expect(failure?.stderr).toMatch(/connection refused|actively refused/i);
    expect(failure?.stderr).not.toContain("synthetic-proxy-user");
    expect(failure?.stderr).not.toContain("synthetic-proxy-secret");
    expect(requests).toEqual([]);
  });

  it("rejects ambiguous explicit inputs before contacting DNS or HTTPS", async () => {
    for (const args of [
      ["login", "--domain", domain, "--email", `employee@${domain}`],
      ["--url", "https://platform.example.test", "login", "--domain", domain],
    ])
      await expect(cli(args)).rejects.toThrow("cannot be used with");
    await expect(
      cli(["login", "--domain", domain], {
        PLATFORM_URL: "https://platform.example.test",
      }),
    ).rejects.toThrow("cannot be used with");
    expect(await readFile(dnsLog, "utf8")).toBe("");
    expect(requests).toEqual([]);
  });
});
