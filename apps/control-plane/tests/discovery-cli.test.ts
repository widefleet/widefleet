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
import { createNativeResolver } from "./fixtures/native-resolver.ts";

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
  let server: ReturnType<typeof createServer>;
  const proxy = createProxy();
  const sockets = new Set<Socket>();
  const requests: { host: string; path: string; authorization: string | undefined }[] = [];
  const connections: string[] = [];

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

    const certificates = await createCertificates(directory, [
      nativeResolver ? `*.${nativeResolver.zone}` : "example.test",
    ]);

    ca = certificates.ca;

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
        request.resume();
        requests.push({
          host: request.headers.host ?? "",
          path: request.url ?? "",
          authorization: request.headers.authorization,
        });
        response.setHeader("content-type", "application/json");

        switch (request.url) {
          case "/.well-known/widefleet":
            response.setHeader("location", "https://unexpected.example.test/");
            response.writeHead(httpsStatus).end(document);
            break;
          case "/api/auth/device/code":
            response.end(
              JSON.stringify({
                device_code: "synthetic-device-code",
                user_code: "TEST-CODE",
                verification_uri: "https://platform.example.test/device",
                expires_in: 60,
                interval: 1,
              }),
            );
            break;
          case "/api/auth/oauth2/token":
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
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = z.object({ port: z.number() }).parse(server.address()).port;
    proxy.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    proxy.on("connect", (request, downstream, head) => {
      connections.push(request.url ?? "");

      if (![`${domain}:443`, "platform.example.test:443"].includes(request.url ?? "")) {
        downstream.end("HTTP/1.1 403 Forbidden\r\n\r\n");

        return;
      }

      const upstream = connect(port, "127.0.0.1", () => {
        downstream.write("HTTP/1.1 200 Connection Established\r\n\r\n");

        if (head.length) upstream.write(head);
        downstream.pipe(upstream).pipe(downstream);
      });

      sockets.add(upstream);
      upstream.on("close", () => sockets.delete(upstream));
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
    await nativeResolver?.close();

    for (const socket of sockets) socket.destroy();

    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });

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

  it.each(["unavailable", "absent"])(
    "uses company HTTPS through the proxy when native DNS is %s",
    async (kind) => {
      if (kind === "absent") await writeFile(responseFile, dnsResponse([], domain));
      const login = await cli(["login", "--email", `private-local-part@${domain}`]);
      expect(login.stderr).toContain(
        kind === "absent" ? "No TXT record" : "System DNS unavailable",
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

  it("rejects an invalid HTTPS destination before sending credentials or starting login", async () => {
    document = JSON.stringify({ platform_url: "http://localhost" });
    await expect(cli(["login", "--domain", domain])).rejects.toThrow(
      "Discovery must specify one HTTPS platform origin",
    );
    expect(requests.map((request) => request.path)).toEqual(["/.well-known/widefleet"]);
    await expect(readFile(configFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([302, 404, 503])(
    "reports HTTPS status %s without following a redirect or starting login",
    async (status) => {
      httpsStatus = status;
      await expect(cli(["login", "--domain", domain])).rejects.toThrow(
        `HTTPS discovery returned ${status}`,
      );
      expect(connections).toEqual([`${domain}:443`]);
      expect(requests.map((request) => request.path)).toEqual(["/.well-known/widefleet"]);
    },
  );

  it("preserves certificate failure details from HTTPS discovery", async () => {
    const untrusted = join(directory, "untrusted");
    await mkdir(untrusted);
    const certificates = await createCertificates(untrusted);

    const failure = await cli(["login", "--domain", domain], {
      SSL_CERT_FILE: certificates.ca,
      SSL_CERT_DIR: untrusted,
    }).then(
      () => null,
      (cause: unknown) => z.object({ stderr: z.string() }).parse(cause),
    );

    expect(failure?.stderr).toContain("Could not discover Widefleet");
    expect(failure?.stderr).toContain("HTTP request failed");
    expect(failure?.stderr).toContain("Caused by:");
    expect(failure?.stderr).toMatch(/certificate|issuer/i);
    expect(requests).toEqual([]);
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

    expect(failure?.stderr).toContain("Could not discover Widefleet");
    expect(failure?.stderr).toContain("HTTP request failed");
    expect(failure?.stderr).toContain("Caused by:");
    expect(failure?.stderr).toMatch(/connection refused|actively refused/i);
    expect(failure?.stderr).not.toContain("synthetic-proxy-user");
    expect(failure?.stderr).not.toContain("synthetic-proxy-secret");
    expect(requests).toEqual([]);
  });

  it("explains noninteractive onboarding without waiting for stdin", async () => {
    await expect(cli(["login"])).rejects.toThrow("widefleet login --email");
    expect(await readFile(dnsLog, "utf8")).toBe("");
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
