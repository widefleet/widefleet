import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const execute = promisify(execFile);

describe.runIf(process.env["RUN_PACKAGED_EDGE_TESTS"] === "1")(
  "Packaged edge configuration",
  () => {
    it.each(["entra", "oidc"])(
      "renders %s runtime configuration and static routes in the production image",
      async (provider) => {
        const result = await execute("docker", [
          "run",
          "--rm",
          "--network=none",
          "--env=PLATFORM_URL=https://platform.example.test",
          "--env=APP_DOMAIN=apps.example.test",
          "--env=PLATFORM_CONFIG_DIRECTORY=/tmp/installation/config",
          `--env=FIXTURE_PROVIDER=${provider}`,
          process.env["PLATFORM_CONTROL_PLANE_IMAGE"] ?? "widefleet-control-plane:sso-check",
          "node",
          "--input-type=module",
          "--eval",
          `
        await import("./tools/configure-edge.ts");
        const { authConfiguration } = await import("@platform/auth-proxy");
        const { companyProvider } = await import("@platform/contracts");
        const { readFile } = await import("node:fs/promises");
        const provider = companyProvider.parse(process.env.FIXTURE_PROVIDER === "entra"
          ? { type: "entra", tenantId: "00000000-0000-4000-8000-000000000001" }
          : { type: "oidc", issuer: "https://login.example.test/company", label: "Company" });
        const routes = JSON.parse(await readFile("/tmp/installation/config/routes/platform.yaml", "utf8"));
        console.log(JSON.stringify({ proxy: authConfiguration.parse({provider, clientId:"apps-client", clientSecret:"fixture-only", cookieSecret:Buffer.alloc(32,1).toString("base64url"),domain:"apps.example.test",redirectUrl:"https://auth.apps.example.test/oauth2/callback"}), routes }));
      `,
        ]);

        const configuration = z
          .object({
            proxy: z.object({ provider: z.object({ type: z.string() }), clientId: z.string() }),
            routes: z.object({
              http: z.object({ services: z.object({ "app-sso": z.unknown() }) }),
            }),
          })
          .parse(JSON.parse(result.stdout));

        expect(configuration.proxy).toMatchObject({
          provider: { type: provider },
          clientId: "apps-client",
        });
        expect(configuration.routes.http.services["app-sso"]).toBeDefined();
      },
      30_000,
    );
  },
);
