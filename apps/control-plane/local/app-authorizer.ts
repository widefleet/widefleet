import { startAppAuthorizer } from "../tools/app-authorizer.ts";
import { authority, tenant, requireLocal } from "./settings.ts";

requireLocal();

const server = startAppAuthorizer(() => `${authority}/${tenant}/v2.0`);

for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => server.close());
