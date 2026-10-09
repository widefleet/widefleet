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
        const { appSsoConfiguration } = await import("./tools/edge-configuration.ts");
        const { companyProvider } = await import("@platform/contracts");
        const { readFile } = await import("node:fs/promises");
        const provider = companyProvider.parse(process.env.FIXTURE_PROVIDER === "entra"
          ? { type: "entra", tenantId: "00000000-0000-4000-8000-000000000001" }
          : { type: "oidc", issuer: "https://login.example.test/company", label: "Company" });
        const routes = JSON.parse(await readFile("/tmp/installation/config/routes/platform.yaml", "utf8"));
        console.log(JSON.stringify({ proxy: appSsoConfiguration(provider, "apps-client", "/runtime/client-secret"), routes }));
      `,
        ]);

        const configuration = z
          .object({
            proxy: z.object({
              providers: z.array(
                z.object({
                  provider: z.string(),
                  clientID: z.string(),
                  clientSecretFile: z.string(),
                }),
              ),
            }),
            routes: z.object({
              http: z.object({ services: z.object({ "app-sso": z.unknown() }) }),
            }),
          })
          .parse(JSON.parse(result.stdout));

        expect(configuration.proxy.providers).toEqual([
          {
            provider: provider === "entra" ? "entra-id" : "oidc",
            clientID: "apps-client",
            clientSecretFile: "/runtime/client-secret",
          },
        ]);
        expect(configuration.routes.http.services["app-sso"]).toBeDefined();
      },
      30_000,
    );
  },
);
