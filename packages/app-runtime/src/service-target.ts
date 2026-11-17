import { hasAppAccess, type appCaller } from "@platform/contracts";
import type { z } from "zod";
import { readApp } from "./catalog.ts";
import { serviceRoute } from "./mcp-authorization.ts";
import type { ParentEnvironment } from "./types.ts";

export const serviceTarget = async (
  environment: ParentEnvironment,
  organizationId: string,
  identity: z.infer<typeof appCaller> & { groups: string[] },
  hostname: string,
  entrypoint: string,
) => {
  const route = await serviceRoute(environment, hostname);

  if (
    !route ||
    route.organizationId !== organizationId ||
    !hasAppAccess(route.access.groups, identity.groups)
  )
    return null;
  const app = await readApp(environment, `hosts/${hostname}.json`);

  if (
    !app ||
    app.appId !== route.appId ||
    app.organizationId !== route.organizationId ||
    !app.metadata.entrypoints?.includes(entrypoint)
  )
    return null;

  return app;
};
