import { companyProvider } from "@platform/contracts";
import { chromium, type Page } from "@playwright/test";
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createCertificates } from "../installation/certificates.ts";
import {
  edgeInfrastructure,
  edgeRoutes,
  appSsoConfiguration,
} from "../../tools/edge-configuration.ts";

const execute = promisify(execFile);

const root = fileURLToPath(new URL("../../../../", import.meta.url));

const observed = z.object({
  headers: z.record(z.string(), z.string()),
  method: z.string(),
  url: z.string(),
});

const appOrigin = "https://notes.apps.localhost:25443";

const navigateAfterContainerChange = async (page: Page, url: string) => {
  let failure: { cause: unknown } | undefined;
  await vi.waitFor(
    async () => {
      try {
        await page.goto(url);
      } catch (cause) {
        // A Docker network change can invalidate the first navigation; its error
        // page may then interrupt the retry. Retry only those transport failures.
        if (
          cause instanceof Error &&
          (cause.message.includes("net::ERR_NETWORK_CHANGED") ||
            cause.message.includes('another navigation to "chrome-error://chromewebdata/"'))
        )
          throw cause;
        failure = { cause };
      }
    },
    { timeout: 10000, interval: 100 },
  );

  if (failure) throw failure.cause;
};

describe
  .runIf(process.env["RUN_EDGE_TESTS"] === "1")
  .each(["emulate", "claims", "overage", "oidc"])(
  "Traefik and OAuth2 Proxy (%s)",
  (providerMode) => {
    const network = `platform-edge-test-${randomUUID()}`;
    const containers: string[] = [];
    let directory: string;
    let accessIssuer: string;
    let browser: Awaited<ReturnType<typeof chromium.launch>>;
    const docker = (...args: string[]) => execute("docker", args);

    const start = async (name: string, args: string[]) => {
      const container = `${network}-${name}`;
      containers.push(container);
      await docker(
        "run",
        "-d",
        "--name",
        container,
        "--network",
        network,
        "--network-alias",
        name,
        ...args,
      );
    };

    beforeAll(async () => {
      directory = await mkdtemp(join(tmpdir(), "platform-edge-"));
      await mkdir(join(directory, "routes"));
      await createCertificates(directory);
      await docker("network", "create", network);

      const configuration = edgeInfrastructure.parse({
        PLATFORM_URL: "https://platform.localhost:25443",
        APP_DOMAIN: "apps.localhost",
      });

      const identity = companyProvider.parse(
        providerMode === "oidc"
          ? {
              type: "oidc",
              issuer: "https://oidc.localhost:25434",
              label: "Company",
              groupsClaim: "roles",
              nameClaim: "display_name",
              emailClaim: "mail",
            }
          : { type: "entra", tenantId: "00000000-0000-4000-8000-000000000001" },
      );

      const original = appSsoConfiguration(
        identity,
        "00000000-0000-4000-8000-000000000002",
        "/run/secrets/app_entra_client_secret",
      );

      const alpha = {
        ...original,
        providers: original.providers.map((provider) =>
          providerMode === "oidc"
            ? provider
            : providerMode === "emulate"
              ? {
                  ...provider,
                  provider: "oidc",
                  oidcConfig: {
                    ...provider.oidcConfig,
                    issuerURL:
                      "http://oidc.localhost:25433/00000000-0000-4000-8000-000000000001/v2.0",
                  },
                }
              : {
                  ...provider,
                  loginURL: "http://oidc.localhost:25433/authorize",
                  redeemURL: "http://oidc.localhost:25433/token",
                  oidcConfig: {
                    ...provider.oidcConfig,
                    skipDiscovery: true,
                    jwksURL: "http://oidc.localhost:25433/jwks",
                  },
                },
        ),
      };

      accessIssuer = alpha.providers[0]?.oidcConfig.issuerURL ?? "";
      await writeFile(join(directory, "oauth2-proxy.json"), JSON.stringify(alpha));
      await writeFile(join(directory, "client-secret"), "local-test-only");
      const routes = edgeRoutes(configuration);
      // The fixture uses Traefik's generated certificate, accepted only by its test browser.
      routes.tls.certificates = [];
      routes.http.services.management.loadBalancer.servers = [
        { url: "http://oidc.localhost:25433" },
      ];
      await writeFile(join(directory, "routes/platform.yaml"), JSON.stringify(routes));
      await cp(join(root, "infra/traefik/app-auth.json"), join(directory, "routes/app-auth.yaml"));
      await writeFile(
        join(directory, "routes/fixture.yaml"),
        JSON.stringify({
          http: {
            routers: {
              fixture: {
                rule: "Host(`notes.apps.localhost`) || Host(`review.notes.apps.localhost`)",
                entryPoints: ["websecure"],
                service: "fixture",
                tls: {},
                middlewares: ["app-auth@file"],
              },
            },
            services: {
              fixture: { loadBalancer: { servers: [{ url: "http://oidc.localhost:25433" }] } },
            },
          },
        }),
      );
      await start("oidc.localhost", [
        "--network-alias",
        "graph.microsoft.com",
        "-v",
        `${directory}:/fixture:ro`,
        "-e",
        `GROUP_OVERAGE=${providerMode === "overage" ? "1" : "0"}`,
        "-e",
        `GENERIC_OIDC=${providerMode === "oidc" ? "1" : "0"}`,
        "-p",
        "127.0.0.1:25434:25434",
        "-p",
        "127.0.0.1:25433:25433",
        "-v",
        `${root}:${root}:ro`,
        "-w",
        root,
        "node:26.8.2-bookworm-slim",
        "node",
        providerMode === "emulate"
          ? "apps/control-plane/tests/edge/emulated-entra.ts"
          : "apps/control-plane/tests/edge/identity-provider.ts",
      ]);
      await vi.waitFor(
        async () =>
          expect((await fetch("http://127.0.0.1:25433/.well-known/openid-configuration")).ok).toBe(
            true,
          ),
        { timeout: 15_000 },
      );
      await start("oauth2-proxy", [
        "-v",
        `${directory}/ca.pem:/fixture/ca.pem:ro`,
        "-e",
        "SSL_CERT_FILE=/fixture/ca.pem",
        "-v",
        `${directory}/oauth2-proxy.json:/config/alpha.json:ro`,
        "-v",
        `${root}/infra/oauth2-proxy/options.cfg:/config/options.cfg:ro`,
        "-v",
        `${directory}/client-secret:/run/secrets/app_entra_client_secret:ro`,
        "-e",
        `OAUTH2_PROXY_COOKIE_SECRET=${randomBytes(32).toString("base64url")}`,
        "quay.io/oauth2-proxy/oauth2-proxy:v7.15.5@sha256:8498b0d0ef0a7b29686414000a08aee467f02d0299c9ed1e006a8f33fc017916",
        "--config=/config/options.cfg",
        "--alpha-config=/config/alpha.json",
        "--cookie-domain=.apps.localhost",
        "--whitelist-domain=.apps.localhost:25443",
        "--redirect-url=https://auth.apps.localhost:25443/oauth2/callback",
      ]);
      await start("app-authorizer", [
        "-v",
        `${root}:${root}:ro`,
        "-w",
        root,
        "-v",
        `${directory}/oauth2-proxy.json:/config/alpha.json:ro`,
        "node:26.8.2-bookworm-slim",
        "node",
        "apps/control-plane/tests/edge/app-authorizer.ts",
      ]);
      await start("traefik", [
        "-p",
        "127.0.0.1:25443:25443",
        "-v",
        `${directory}/routes:/routes:ro`,
        "traefik:v3.7.13@sha256:24841fe2de7304c149343d877d2923b4c8800a38ba015dea9174c23b20e344a0",
        "--entrypoints.websecure.address=:25443",
        "--providers.file.directory=/routes",
        "--providers.file.watch=true",
      ]);
      browser = await chromium.launch();
      const context = await browser.newContext({ ignoreHTTPSErrors: true });
      await vi.waitFor(
        async () =>
          expect(
            (await context.request.get(`${appOrigin}/echo`, { maxRedirects: 0 })).status(),
          ).toBe(302),
        { timeout: 20_000 },
      );
      await context.close();
    }, 60_000);

    afterAll(async () => {
      await browser?.close();

      for (const container of containers.toReversed()) {
        const logs = await docker("logs", container).catch(() => null);

        if (logs?.stderr) console.info(logs.stderr);
        await docker("rm", "-f", container).catch(() => undefined);
      }

      await docker("network", "rm", network).catch(() => undefined);

      if (directory) await rm(directory, { recursive: true, force: true });
    });

    it.each([appOrigin, "https://review.notes.apps.localhost:25443"])(
      "requires SSO, overwrites spoofed identity, strips app credentials and preserves management cookies on %s",
      async (origin) => {
        const context = await browser.newContext({ ignoreHTTPSErrors: true });
        const page = await context.newPage();

        const anonymous = await context.request.get(`${origin}/echo`, {
          maxRedirects: 0,
          headers: { "x-auth-request-user": "forged", authorization: "Bearer forged" },
        });

        expect(anonymous.status()).toBe(302);
        await navigateAfterContainerChange(page, `${origin}/echo?return=preserved`);

        if (providerMode === "emulate")
          await page.getByRole("button", { name: /sso@example.test/ }).click();
        await vi.waitFor(() => expect(page.url()).toBe(`${origin}/echo?return=preserved`));
        const initial = observed.parse(JSON.parse(await page.locator("body").innerText()));

        if (providerMode === "oidc")
          expect(initial.headers["x-auth-request-user"]).toBe("pairwise-test-subject");
        else if (providerMode === "emulate")
          expect(z.uuid().safeParse(initial.headers["x-auth-request-user"]).success).toBe(true);
        else
          expect(initial.headers["x-auth-request-user"]).toBe(
            "00000000-0000-4000-8000-000000000004",
          );
        expect(initial.headers["x-auth-request-preferred-username"]).toBe("SSO Test User");
        expect(initial.headers["x-auth-request-email"]).toBe("sso@example.test");
        expect(initial.headers["x-auth-request-groups"]).toBe(
          providerMode === "overage"
            ? Array.from(
                { length: 205 },
                (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
              ).join(",")
            : providerMode === "claims" || providerMode === "oidc"
              ? "test-group"
              : undefined,
        );

        const session = (await context.cookies()).find(
          (cookie) => cookie.name === "__Secure-platform_sso",
        );

        expect(session).toMatchObject({
          httpOnly: true,
          secure: true,
          sameSite: "Lax",
          domain: ".apps.localhost",
        });

        await context.addCookies([{ name: "own_app_cookie", value: "hidden", url: origin }]);

        const response = await context.request.post(`${origin}/echo`, {
          headers: {
            "x-auth-request-user": "forged",
            "x-auth-request-email": "forged@example.test",
            "x-auth-request-preferred-username": "forged",
            "x-auth-request-groups": "administrators",
            "x-auth-request-access-token": "forged",
            authorization: "Bearer forged",
            "x-forwarded-host": "attacker.example.test",
            "x-forwarded-proto": "http",
          },
          form: { hello: "world" },
        });

        expect(response.status()).toBe(200);
        const body = observed.parse(await response.json());
        expect(body.headers["x-auth-request-user"]).toBe(initial.headers["x-auth-request-user"]);
        expect(body.headers["x-auth-request-groups"]).toBe(
          providerMode === "overage"
            ? Array.from(
                { length: 205 },
                (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
              ).join(",")
            : providerMode === "claims" || providerMode === "oidc"
              ? "test-group"
              : undefined,
        );
        expect(body.headers["x-forwarded-proto"]).toBe("https");
        expect(body.headers["x-forwarded-host"]).toBe(new URL(origin).host);

        for (const header of ["cookie", "authorization", "x-auth-request-access-token"])
          expect(body.headers[header]).toBeUndefined();
        expect(response.headers()["set-cookie"]).toBeUndefined();

        const management = await context.request.get("https://platform.localhost:25443/echo", {
          headers: { cookie: "management_session=preserved" },
        });

        expect(observed.parse(await management.json()).headers["cookie"]).toBe(
          "management_session=preserved",
        );
        expect(management.headers()["set-cookie"]).toContain("app_cookie=");
        // This network has only the IdP, echo app and proxies: no control plane or database.
        await docker("restart", `${network}-oauth2-proxy`, `${network}-traefik`);
        await vi.waitFor(
          async () => expect((await context.request.get(`${origin}/echo`)).status()).toBe(200),
          { timeout: 10_000 },
        );
        const fresh = await browser.newContext({ ignoreHTTPSErrors: true });
        const freshPage = await fresh.newPage();

        await navigateAfterContainerChange(freshPage, `${origin}/echo`);

        if (providerMode === "emulate")
          await freshPage.getByRole("button", { name: /sso@example.test/ }).click();
        await vi.waitFor(() => expect(freshPage.url()).toBe(`${origin}/echo`));
        await fresh.close();
        await context.close();
      },
      30_000,
    );
    it("enforces person and group roles before app code and updates existing sessions", async () => {
      const context = await browser.newContext({ ignoreHTTPSErrors: true });
      const page = await context.newPage();
      const previewOrigin = "https://review.notes.apps.localhost:25443";

      const allowed =
        providerMode === "overage" ? "00000000-0000-4000-8000-000000000204" : "test-group";

      const writeRules = async (
        groups: string[],
        revision: number,
        users: string[] = [],
        allAuthenticated = false,
      ) => {
        const entries = [
          { name: "fixture", host: "notes.apps.localhost", groups },
          { name: "preview", host: "review.notes.apps.localhost", groups },
        ];

        await writeFile(
          join(directory, "routes/fixture.yaml"),
          JSON.stringify({
            http: {
              routers: Object.fromEntries(
                entries.map(({ name, host }) => [
                  name,
                  {
                    rule: `Host(\`${host}\`)`,
                    entryPoints: ["websecure"],
                    service: "fixture",
                    tls: {},
                    middlewares: [
                      "clear-client-identity@file",
                      `${name}-revision@file`,
                      `${name}-groups@file`,
                      "remove-app-credentials@file",
                    ],
                  },
                ]),
              ),
              middlewares: {
                ...Object.fromEntries(
                  entries.map(
                    ({ name }) =>
                      [
                        `${name}-revision`,
                        {
                          headers: {
                            customResponseHeaders: {
                              "X-Widefleet-Access-Revision": `${name}:${revision}`,
                            },
                          },
                        },
                      ] as const,
                  ),
                ),
                ...Object.fromEntries(
                  entries.map(
                    ({ name, groups: selected }) =>
                      [
                        `${name}-groups`,
                        {
                          forwardAuth: {
                            address: `http://app-authorizer:4181/authorize?${new URLSearchParams({ policy: Buffer.from(JSON.stringify({ revision, provider: accessIssuer, groups: selected, users, allAuthenticated })).toString("base64url") })}`,
                            authRequestHeaders: ["Cookie", "User-Agent", "Accept"],
                            authResponseHeaders: [
                              "X-Auth-Request-User",
                              "X-Auth-Request-Email",
                              "X-Auth-Request-Preferred-Username",
                              "X-Auth-Request-Groups",
                            ],
                          },
                        },
                      ] as const,
                  ),
                ),
              },
              services: {
                fixture: { loadBalancer: { servers: [{ url: "http://oidc.localhost:25433" }] } },
              },
            },
          }),
        );
        // An anonymous rejection with this marker proves that the new chain,
        // including authentication, has been loaded before reporting it active.
        const anonymous = await browser.newContext({ ignoreHTTPSErrors: true });

        try {
          await vi.waitFor(
            async () => {
              const response = await anonymous.request.get(appOrigin, { maxRedirects: 0 });
              expect(response.status()).toBe(302);
              expect(response.headers()["x-widefleet-access-revision"]).toBe(`fixture:${revision}`);
            },
            { timeout: 10000 },
          );
        } finally {
          await anonymous.close();
        }
      };

      try {
        await navigateAfterContainerChange(page, `${appOrigin}/echo`);

        if (providerMode === "emulate")
          await page.getByRole("button", { name: /sso@example.test/ }).click();
        await vi.waitFor(() => expect(page.url()).toBe(`${appOrigin}/echo`));

        const signedIn = observed.parse(
          await (await context.request.get(`${appOrigin}/echo`)).json(),
        );

        const subject = z.string().parse(signedIn.headers["x-auth-request-user"]);
        await writeRules(
          providerMode === "emulate" ? [] : ["unrelated", allowed],
          1,
          [],
          providerMode === "emulate",
        );
        expect((await context.request.get(`${appOrigin}/echo`)).status()).toBe(200);
        expect((await context.request.get(`${previewOrigin}/echo`)).status()).toBe(200);
        await writeRules(["denied-group"], 2);

        for (const path of ["/echo", "/private.txt", `/?allowed_groups=${allowed}`]) {
          const denied = await context.request.get(`${previewOrigin}${path}`, {
            maxRedirects: 0,
            headers: { "x-auth-request-groups": "denied-group", "x-auth-request-user": "forged" },
          });

          expect(denied.status()).toBe(403);
        }

        expect(
          (await context.request.post(`${appOrigin}/echo`, { data: "not delivered" })).status(),
        ).toBe(403);
        await writeRules([], 3, [subject]);
        expect((await context.request.get(`${appOrigin}/echo`)).status()).toBe(200);
        expect((await context.request.get(`${previewOrigin}/echo`)).status()).toBe(200);
        await writeRules([], 4, ["another-person"]);
        expect((await context.request.get(`${appOrigin}/echo`)).status()).toBe(403);
        await writeRules([], 5);
        expect((await context.request.get(`${appOrigin}/echo`)).status()).toBe(403);
        await writeRules([], 6, [], true);
        expect((await context.request.get(`${appOrigin}/echo`)).status()).toBe(200);
        expect((await context.request.get(`${previewOrigin}/echo`)).status()).toBe(200);
        await docker("restart", `${network}-traefik`, `${network}-app-authorizer`);
        await vi.waitFor(
          async () =>
            expect((await context.request.get(`${previewOrigin}/echo`)).status()).toBe(200),
          { timeout: 10000 },
        );
      } finally {
        await context.close();
      }
    }, 30_000);
  },
);
