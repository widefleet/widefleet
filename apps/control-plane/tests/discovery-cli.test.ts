import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createProxy } from "node:http";
import { createServer } from "node:https";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createCertificates } from "./installation/certificates.ts";

const execute = promisify(execFile);

const dnsResponse = (urls: string[]) => {
  const name = Buffer.concat([
    ...["_widefleet", "example", "test"].map((label) =>
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

describe.runIf(process.env["RUN_CLI_TESTS"] === "1" && process.platform === "linux")(
  "CLI discovery through native TXT and a local HTTPS proxy",
  () => {
    let directory: string;
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
      const certificates = await createCertificates(directory, ["example.test"]);
      ca = certificates.ca;
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

        if (!["example.test:443", "platform.example.test:443"].includes(request.url ?? "")) {
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
    });

    beforeEach(async () => {
      const id = crypto.randomUUID();
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

    afterAll(async () => {
      for (const socket of sockets) socket.destroy();

      if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    });

    const cli = (args: string[], overrides: NodeJS.ProcessEnv = {}) =>
      execute(
        process.env["CLI_BINARY"] ??
          fileURLToPath(new URL("../../../target/debug/widefleet", import.meta.url)),
        args,
        {
          timeout: 12000,
          env: {
            ...process.env,
            PLATFORM_URL: undefined,
            PLATFORM_CONFIG_FILE: configFile,
            PLATFORM_SESSION_FILE: sessionFile,
            PLATFORM_ACCESS_TOKEN: "external-token-must-not-reach-discovery",
            WIDEFLEET_TELEMETRY_DISABLED: "1",
            XDG_STATE_HOME: join(directory, "state"),
            LD_PRELOAD: join(directory, "resolver.so"),
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
      await writeFile(responseFile, dnsResponse(["https://platform.example.test"]));
      await cli(["login", "--email", "private-local-part@example.test"]);
      expect(await readFile(dnsLog, "utf8")).toBe("_widefleet.example.test. 1 16\n");
      expect(requests.map((request) => request.path)).toEqual([
        "/api/auth/device/code",
        "/api/auth/oauth2/token",
      ]);
      expect(JSON.parse(await readFile(configFile, "utf8"))).toEqual({
        platform_url: "https://platform.example.test",
      });
      await cli(["whoami"]);
      expect(await readFile(dnsLog, "utf8")).toBe("_widefleet.example.test. 1 16\n");
      expect(connections.every((host) => host === "platform.example.test:443")).toBe(true);
    });

    it.each(["unavailable", "absent"])(
      "uses company HTTPS through the proxy when native DNS is %s",
      async (kind) => {
        if (kind === "absent") await writeFile(responseFile, dnsResponse([]));
        await cli(["login", "--email", "private-local-part@example.test"]);
        expect(requests[0]).toEqual({
          host: "example.test",
          path: "/.well-known/widefleet",
          authorization: undefined,
        });
        expect(requests.every((request) => request.authorization === undefined)).toBe(true);
        expect(JSON.parse(await readFile(configFile, "utf8"))).toEqual({
          platform_url: "https://platform.example.test",
        });
        expect(await readFile(dnsLog, "utf8")).not.toContain("private-local-part");
        expect(connections).toContain("example.test:443");
      },
    );

    it("falls back after the native deadline and exits without waiting for the resolver thread", async () => {
      await cli(["login", "--domain", "example.test"], { WIDEFLEET_TEST_DNS_DELAY: "1" });
      expect(requests[0]?.path).toBe("/.well-known/widefleet");
    }, 12000);

    it("explicit company selection replaces a saved URL only after login succeeds", async () => {
      await writeFile(
        configFile,
        JSON.stringify({ platform_url: "https://previous.example.test" }),
      );
      await cli(["login", "--domain", "example.test"]);
      expect(JSON.parse(await readFile(configFile, "utf8"))).toEqual({
        platform_url: "https://platform.example.test",
      });
    });

    it("rejects conflicting DNS records without trying HTTPS or changing configuration", async () => {
      await writeFile(
        configFile,
        JSON.stringify({ platform_url: "https://previous.example.test" }),
      );
      await writeFile(
        responseFile,
        dnsResponse(["https://platform.example.test", "https://other.example.test"]),
      );
      await expect(cli(["login", "--domain", "example.test"])).rejects.toThrow(
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
      await expect(cli(["login", "--domain", "example.test"])).rejects.toThrow(
        "Discovery must specify one HTTPS platform origin",
      );
      expect(requests.map((request) => request.path)).toEqual(["/.well-known/widefleet"]);
      await expect(readFile(configFile)).rejects.toMatchObject({ code: "ENOENT" });
    });

    it.each([302, 404, 503])(
      "reports HTTPS status %s without following a redirect or starting login",
      async (status) => {
        httpsStatus = status;
        await expect(cli(["login", "--domain", "example.test"])).rejects.toThrow(
          `HTTPS discovery returned ${status}`,
        );
        expect(connections).toEqual(["example.test:443"]);
        expect(requests.map((request) => request.path)).toEqual(["/.well-known/widefleet"]);
      },
    );

    it("explains noninteractive onboarding without waiting for stdin", async () => {
      await expect(cli(["login"])).rejects.toThrow("widefleet login --email");
      expect(await readFile(dnsLog, "utf8")).toBe("");
      expect(requests).toEqual([]);
    });

    it("rejects ambiguous explicit inputs before contacting DNS or HTTPS", async () => {
      for (const args of [
        ["login", "--domain", "example.test", "--email", "employee@example.test"],
        ["--url", "https://platform.example.test", "login", "--domain", "example.test"],
      ])
        await expect(cli(args)).rejects.toThrow("cannot be used with");
      await expect(
        cli(["login", "--domain", "example.test"], {
          PLATFORM_URL: "https://platform.example.test",
        }),
      ).rejects.toThrow("cannot be used with");
      expect(await readFile(dnsLog, "utf8")).toBe("");
      expect(requests).toEqual([]);
    });
  },
);
