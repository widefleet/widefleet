import { appAccessSnapshot, organizationIdentifier } from "@platform/contracts";
import { z } from "zod";
import { readApp, readServiceDocumentation } from "./catalog.ts";
import { serviceRoute } from "./mcp-authorization.ts";
import { serviceTerms } from "./mcp-search.ts";
import type { ParentEnvironment } from "./types.ts";

// One object per organization holds what search needs, so a search reads one
// object instead of every app's route, publication and documentation.
// Publishers refresh a host after committing its route and publication; a
// missing or expired index is rebuilt from the published state.
const indexedService = z.strictObject({
  appId: z.string(),
  access: appAccessSnapshot,
  entrypoints: z.array(
    z.strictObject({ name: z.string(), summary: z.string().max(256), terms: z.string() }),
  ),
});

const indexedServices = z.record(z.string(), indexedService);

const serviceIndex = z.strictObject({
  format: z.literal(1),
  // Start of the last completed scan; 0 until a scan completes.
  builtAt: z.number().int().nonnegative(),
  services: indexedServices,
  // A rebuild in progress. Refreshes apply to it as well, so completing it
  // cannot drop a host published while it ran.
  scan: z
    .strictObject({
      startedAt: z.number().int().nonnegative(),
      cursor: z.string().nullable(),
      services: indexedServices,
    })
    .optional(),
});

type ServiceIndex = z.infer<typeof serviceIndex>;

type IndexedService = z.infer<typeof indexedService>;

type IndexedServices = z.infer<typeof indexedServices>;

// Rebuilding bounds the effect of a lost refresh; publishers keep the index current.
const maximumAge = 24 * 60 * 60 * 1000;

// Route keys carry no organization, so a rebuild reads every route of the
// installation. Each search advances it by a bounded number of routes, which
// keeps a search within request limits on any installation size.
const scanBudget = 200;

const scanConcurrency = 6;

const indexKey = (organizationId: string) =>
  `service-index/${organizationIdentifier.parse(organizationId)}.json`;

const indexedState = async (
  environment: ParentEnvironment,
  organizationId: string,
  hostname: string,
) => {
  const route = await serviceRoute(environment, hostname);

  if (!route || route.organizationId !== organizationId) return null;

  const app = await readApp(environment, `hosts/${hostname}.json`, {
    appId: route.appId,
    organizationId: route.organizationId,
  });

  if (!app || app.appId !== route.appId || app.organizationId !== route.organizationId) return null;
  const entrypoints = app.metadata.entrypoints ?? [];

  if (!entrypoints.length) return null;
  const documentation = await readServiceDocumentation(environment, app);

  return indexedService.parse({
    appId: app.appId,
    access: route.access,
    entrypoints: entrypoints.map((name) => {
      const entry = documentation?.entrypoints.find((candidate) => candidate.name === name);

      return {
        name,
        summary: (entry?.summary ?? "").slice(0, 256),
        terms: serviceTerms(hostname, name, entry),
      };
    }),
  });
};

const read = async (environment: ParentEnvironment, organizationId: string) => {
  const object = await environment.WIDEFLEET_PACKAGES.get(indexKey(organizationId));

  return object ? { etag: object.etag, index: serviceIndex.parse(await object.json()) } : null;
};

// Conditional on the object read before the work started, so a concurrent
// refresh or scan always wins over a result computed from older state.
const write = (
  environment: ParentEnvironment,
  organizationId: string,
  index: ServiceIndex,
  etag: string | null,
) =>
  environment.WIDEFLEET_PACKAGES.put(indexKey(organizationId), JSON.stringify(index), {
    onlyIf: etag ? { etagMatches: etag } : { etagDoesNotMatch: "*" },
    httpMetadata: { contentType: "application/json" },
  });

const withState = (services: IndexedServices, hostname: string, state: IndexedService | null) => {
  const next = { ...services };

  if (state) next[hostname] = state;
  else delete next[hostname];

  return next;
};

const scanStates = async (
  environment: ParentEnvironment,
  organizationId: string,
  hostnames: string[],
) => {
  const states: { hostname: string; state: IndexedService | null }[] = [];

  for (let offset = 0; offset < hostnames.length; offset += scanConcurrency)
    states.push(
      ...(await Promise.all(
        hostnames.slice(offset, offset + scanConcurrency).map(async (hostname) => ({
          hostname,
          state: await indexedState(environment, organizationId, hostname),
        })),
      )),
    );

  return states;
};

// Returns the services to search. While a rebuild is in progress, they are the
// last complete index updated with every route scanned so far, and complete is
// false: a lost refresh may still hide a service the rebuild has not reached.
export const readServiceIndex = async (
  environment: ParentEnvironment,
  organizationId: string,
): Promise<{ services: IndexedServices; complete: boolean }> => {
  const current = await read(environment, organizationId);
  const index = current?.index ?? { format: 1 as const, builtAt: 0, services: {} };

  if (!index.scan && index.builtAt && Date.now() - index.builtAt < maximumAge)
    return { services: index.services, complete: true };
  const scan = index.scan ?? { startedAt: Date.now(), cursor: null, services: {} };
  const options: KVNamespaceListOptions = { prefix: "apps/", limit: scanBudget };

  if (scan.cursor) options.cursor = scan.cursor;
  const page = await environment.AUTH_CONFIG.list(options);

  const scanned = (
    await scanStates(
      environment,
      organizationId,
      page.keys.map((key) => key.name.slice("apps/".length)),
    )
  ).reduce((services, { hostname, state }) => withState(services, hostname, state), scan.services);

  const next: ServiceIndex = page.list_complete
    ? { format: 1, builtAt: scan.startedAt, services: scanned }
    : {
        ...index,
        scan: { startedAt: scan.startedAt, cursor: page.cursor, services: scanned },
      };

  // A lost write only repeats this step on the next search.
  await write(environment, organizationId, next, current?.etag ?? null);

  return {
    services: next.scan ? { ...index.services, ...scanned } : scanned,
    complete: !next.scan,
  };
};

export const refreshServiceIndex = async (
  environment: ParentEnvironment,
  organizationId: string,
  hostname: string,
) => {
  for (let attempt = 0; attempt < 8; attempt++) {
    const current = await read(environment, organizationId);
    const state = await indexedState(environment, organizationId, hostname);

    // Without an index, this creates an expired one, so the next search scans
    // the installation and a search that scanned before this refresh cannot
    // save its older result.
    const index = current?.index ?? { format: 1 as const, builtAt: 0, services: {} };

    const next: ServiceIndex = {
      ...index,
      services: withState(index.services, hostname, state),
      ...(index.scan && {
        scan: { ...index.scan, services: withState(index.scan.services, hostname, state) },
      }),
    };

    // Write even when nothing changed: a scan that read the index before this
    // refresh may hold this host's previous state and must not save it.
    if (await write(environment, organizationId, next, current?.etag ?? null)) return;
  }

  throw new Error("The service index changed during every refresh attempt");
};
