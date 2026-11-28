import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import { routeTree } from "../.platform/routeTree.gen.ts";
import { reportError } from "./lib/report-error.ts";

export const getRouter = () => {
  // One client per router: on the server, each request renders with its own cache, so one
  // person's notes can never appear in another person's page.
  const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 30_000 } } });

  const router = createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    defaultPreloadStaleTime: 0,
    defaultOnCatch: reportError,
    defaultErrorComponent: () => <p role="alert">Die Seite konnte nicht geladen werden.</p>,
    defaultNotFoundComponent: () => <p>Seite nicht gefunden.</p>,
  });

  setupRouterSsrQueryIntegration({ router, queryClient });

  return router;
};
