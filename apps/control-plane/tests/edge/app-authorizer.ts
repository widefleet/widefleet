import { readFile } from "node:fs/promises";
import { z } from "zod";
import { startAppAuthorizer } from "../../tools/app-authorizer.ts";

const configuration = z
  .object({
    providers: z.array(z.object({ oidcConfig: z.object({ issuerURL: z.string() }) })).min(1),
  })
  .parse(JSON.parse(await readFile("/config/alpha.json", "utf8")));

const server = startAppAuthorizer(
  () => configuration.providers[0]?.oidcConfig.issuerURL ?? null,
  4181,
  "http://oauth2-proxy:4180/",
);

for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => server.close());
