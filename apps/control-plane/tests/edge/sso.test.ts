import { get } from "node:https";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { installedAuth, docker } from "../installation/installed-auth.ts";
import { createCertificates } from "../installation/certificates.ts";
import { edgeInfrastructure, edgeRoutes } from "../../tools/edge-configuration.ts";

describe.runIf(process.env["RUN_PACKAGED_EDGE_TESTS"] === "1")(
  "Traefik with the installed auth proxy",
  () => {
    it("protects app requests, strips forwarding headers, and preserves management cookies", async () => {
      const fixture = await installedAuth();
      const proxy = `${fixture.name}-traefik`;

      try {
        await fixture.start();
        await fixture.startProvider();
        await fixture.publish();
        await fixture.route([]);
        await docker(
          "exec",
          "-d",
          fixture.client,
          "node",
          "--input-type=module",
          "--eval",
          'import {createServer} from "node:http"; createServer((request,response)=>{response.setHeader("set-cookie","management-cookie=preserved");response.end(JSON.stringify({headers:request.headers}));}).listen(4183,"0.0.0.0");',
        );
        const certificates = await createCertificates(fixture.directory);

        const routes = edgeRoutes(
          edgeInfrastructure.parse({
            PLATFORM_URL: "https://platform.example.test",
            APP_DOMAIN: "apps.example.test",
          }),
        );

        routes.http.services["app-sso"].loadBalancer.servers = [
          { url: `http://${fixture.name}:8080` },
        ];
        routes.http.services.management.loadBalancer.servers = [
          { url: `http://${fixture.name}:4183` },
        ];

        const combined = {
          ...routes,
          http: {
            ...routes.http,
            routers: {
              ...routes.http.routers,
              app: {
                rule: "Host(`notes.apps.example.test`)",
                entryPoints: ["websecure"],
                service: "app-sso",
                tls: {},
              },
            },
          },
        };

        await mkdir(join(fixture.directory, "routes"));
        await writeFile(join(fixture.directory, "routes/platform.yaml"), JSON.stringify(combined));
        await docker(
          "run",
          "-d",
          "--name",
          proxy,
          "--network=internal-app-platform-test_default",
          "--publish",
          "127.0.0.1::8443",
          "--volume",
          `${fixture.directory}/routes:/routes:ro`,
          "--volume",
          `${certificates.certificate}:/tls/fullchain.pem:ro`,
          "--volume",
          `${certificates.key}:/tls/privkey.pem:ro`,
          "traefik:v3.7.13@sha256:24841fe2de7304c149343d877d2923b4c8800a38ba015dea9174c23b20e344a0",
          "--entrypoints.websecure.address=:8443",
          "--providers.file.directory=/routes",
          "--providers.file.watch=true",
        );

        const port = new URL(`https://${(await docker("port", proxy, "8443/tcp")).stdout.trim()}`)
          .port;

        const ca = await readFile(certificates.ca);

        const request = (
          hostname: string,
          headers: Record<string, string> = {},
          path = "/report",
        ) =>
          new Promise<{
            status: number;
            headers: import("node:http").IncomingHttpHeaders;
            body: string;
          }>((resolve, reject) => {
            const outgoing = get(
              {
                hostname: "127.0.0.1",
                port,
                servername: hostname,
                ca,
                path,
                headers: { ...headers, host: hostname },
              },
              (response) => {
                let body = "";
                response.setEncoding("utf8").on("data", (part: string) => {
                  body += part;
                });
                response.on("end", () =>
                  resolve({ status: response.statusCode ?? 0, headers: response.headers, body }),
                );
              },
            );

            outgoing.on("error", reject);
          });

        await vi.waitFor(
          async () => expect((await request("notes.apps.example.test")).status).toBe(401),
          { timeout: 10_000 },
        );

        const anonymous = await request("notes.apps.example.test", {
          accept: "text/html",
          "x-auth-request-user": "forged",
        });

        expect(anonymous.status).toBe(302);
        expect(anonymous.headers.location).toBe(
          "https://auth.apps.example.test/oauth2/start?rd=https%3A%2F%2Fnotes.apps.example.test%2Freport",
        );
        const login = await fixture.login();

        const authenticated = await request("notes.apps.example.test", {
          cookie: login.cookie,
          "x-forwarded-host": "attacker.example.test",
          "x-forwarded-proto": "http",
          "x-auth-request-user": "forged",
          authorization: "Bearer must-not-leak",
        });

        expect(authenticated.status).toBe(200);

        const echoed = z
          .object({ headers: z.record(z.string(), z.string()) })
          .parse(JSON.parse(authenticated.body));

        expect(echoed.headers["x-auth-request-user"]).toBe("rotation-user");
        expect(echoed.headers).not.toHaveProperty("x-forwarded-host");
        expect(echoed.headers).not.toHaveProperty("x-forwarded-proto");
        expect(echoed.headers).not.toHaveProperty("cookie");
        expect(echoed.headers).not.toHaveProperty("authorization");
        expect(authenticated.headers["set-cookie"]).toBeUndefined();
        await fixture.route(["administrators"], 2);
        expect(
          (
            await request("notes.apps.example.test", {
              cookie: login.cookie,
              "x-auth-request-groups": "administrators",
            })
          ).status,
        ).toBe(403);

        const management = await request("platform.example.test", {
          cookie: "management=preserved",
        });

        expect(management.status).toBe(200);
        expect(JSON.parse(management.body)).toMatchObject({
          headers: { cookie: "management=preserved" },
        });
        expect(management.headers["set-cookie"]).toEqual(["management-cookie=preserved"]);
        expect(
          (await request("auth.apps.example.test", {}, "/.well-known/widefleet/auth/configuration"))
            .status,
        ).toBe(403);
      } finally {
        await docker("rm", "--force", proxy).catch(() => undefined);
        await fixture.dispose();
      }
    }, 90_000);
  },
);
