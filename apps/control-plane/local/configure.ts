import { chown, mkdir, writeFile } from "node:fs/promises";
import { edgeInfrastructure, edgeRoutes } from "../tools/edge-configuration.ts";
import { clientId, requireLocal, tenant } from "./settings.ts";

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

await writeFile("/data/routes/platform.yaml", JSON.stringify(localRoutes));
