import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { edgeInfrastructure, edgeRoutes, traefikConfiguration } from "./edge-configuration.ts";

const configuration = edgeInfrastructure.parse(process.env);

const directory = resolve(process.env["PLATFORM_CONFIG_DIRECTORY"] ?? "../../.local/config");

await mkdir(resolve(directory, "routes"), { recursive: true, mode: 0o700 });

await writeFile(
  resolve(directory, "traefik.json"),
  JSON.stringify(traefikConfiguration(configuration)),
);

await writeFile(
  resolve(directory, "routes/platform.yaml"),
  JSON.stringify(edgeRoutes(configuration)),
);

await copyFile(
  new URL("../../../infra/traefik/app-auth.json", import.meta.url),
  resolve(directory, "routes/app-auth.yaml"),
);
