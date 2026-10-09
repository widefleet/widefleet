import { chown, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import {
  edgeInfrastructure,
  edgeRoutes,
  appSsoConfiguration,
} from "../tools/edge-configuration.ts";
import { authority, clientId, clientSecret, requireLocal, tenant } from "./settings.ts";

requireLocal();

await chown("/telemetry-queue", 10001, 10001);

await mkdir("/data/routes", { recursive: true });

await mkdir("/data/agent", { recursive: true });

const configuration = edgeInfrastructure.parse({
  PLATFORM_URL: "https://platform.localhost:25453",
  APP_DOMAIN: "apps.localhost",
  ENTRA_TENANT_ID: tenant,
  APP_ENTRA_CLIENT_ID: clientId,
});

const routes = edgeRoutes(configuration);

routes.tls.certificates = [];

routes.http.routers.management.rule = "Host(`localhost`) || Host(`widefleet-local-proxy`)";

routes.http.routers.management.entryPoints = ["management"];

// The management fixture listens on loopback HTTP; apps retain the normal TLS route.
const { tls: _managementTls, ...management } = routes.http.routers.management;

const localRoutes = {
  ...routes,
  http: { ...routes.http, routers: { ...routes.http.routers, management } },
};

routes.http.services.management.loadBalancer.servers = [{ url: "http://127.0.0.1:3000" }];

routes.http.services["app-sso"].loadBalancer.servers = [{ url: "http://127.0.0.1:4180" }];

await writeFile("/data/routes/platform.yaml", JSON.stringify(localRoutes));

const alpha = appSsoConfiguration(
  { type: "entra", tenantId: tenant, authority, label: "Microsoft" },
  clientId,
  "/run/secrets/app_entra_client_secret",
);

for (const provider of alpha.providers) {
  // The emulator has a local issuer; native Entra requires Microsoft's issuer format.
  provider.provider = "oidc";
  provider.oidcConfig.issuerURL = `${authority}/${tenant}/v2.0`;
}

await writeFile("/data/oauth2-proxy.json", JSON.stringify(alpha));

await writeFile("/data/client-secret", clientSecret, { mode: 0o444 });

const middleware = await readFile("/workspace/infra/traefik/app-auth.json", "utf8");

await writeFile(
  "/data/routes/app-auth.yaml",
  middleware.replace("http://oauth2-proxy:4180/", "http://127.0.0.1:4180/"),
);

await copyFile("/workspace/infra/oauth2-proxy/options.cfg", "/data/options.cfg");
