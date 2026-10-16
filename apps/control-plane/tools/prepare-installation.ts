import { fileURLToPath } from "node:url";
import { readConfiguration } from "../src/lib/server/config.ts";
import { prepareInstallation } from "../src/lib/server/runtime-initialization.ts";

const installation = await prepareInstallation(
  readConfiguration(),
  fileURLToPath(new URL("../migrations", import.meta.url)),
);

await installation.database.close();
