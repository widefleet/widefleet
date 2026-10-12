import type { getRouter } from "./router.tsx";
import type { startInstance } from "./start.ts";
import type { PlatformContext } from "./lib/server/context.ts";

// Keep registration on the same export as Start's generated route-tree declaration.
declare module "@tanstack/react-start" {
  interface Register {
    ssr: true;
    router: Awaited<ReturnType<typeof getRouter>>;
    config: Awaited<ReturnType<typeof startInstance.getOptions>>;
    server: { requestContext: PlatformContext };
  }
}
