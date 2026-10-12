import { createRouter } from "@tanstack/react-router";
import { routeTree } from "../.platform/routeTree.gen.ts";
import { reportError } from "./lib/report-error.ts";

export const getRouter = () =>
  createRouter({
    routeTree,
    scrollRestoration: true,
    defaultOnCatch: reportError,
    defaultErrorComponent: () => <p role="alert">Die Seite konnte nicht geladen werden.</p>,
    defaultNotFoundComponent: () => <p>Seite nicht gefunden.</p>,
  });
