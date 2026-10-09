import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  edgeInfrastructure,
  edgeRoutes,
  traefikConfiguration,
} from "../../../tools/edge-configuration.ts";
import type { Configuration } from "./config.ts";
import { writePrivateFile } from "./installation-files.ts";

export const initializeEdge = async (configuration: Configuration) => {
  const directory = configuration.PLATFORM_CONFIG_DIRECTORY;

  if (!directory) return;
  const edge = edgeInfrastructure.parse(configuration);
  await writePrivateFile(
    join(directory, "traefik.json"),
    JSON.stringify(traefikConfiguration(edge)),
  );
  await writePrivateFile(join(directory, "routes/platform.yaml"), JSON.stringify(edgeRoutes(edge)));
  await writePrivateFile(
    join(directory, "routes/app-auth.yaml"),
    await readFile("/infra/traefik/app-auth.json", "utf8"),
  );
};
