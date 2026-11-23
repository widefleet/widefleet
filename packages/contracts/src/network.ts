import { z } from "zod";

export const networkOrigin = z.string().refine((value) => {
  const url = URL.parse(value);

  return (
    url !== null &&
    url.protocol === "https:" &&
    url.origin === value &&
    !url.hostname.includes("*") &&
    !url.username &&
    !url.password
  );
}, "Use an exact HTTPS origin, for example https://api.example.com (no path or wildcard)");

const origins = z
  .array(networkOrigin)
  .refine((values) => new Set(values).size === values.length, "Origins must be unique");

export const networkPolicy = z.strictObject({ backend: origins, browser: origins });

/**
 * The origins an app declares in widefleet.jsonc. A deployment requests them;
 * only the app's owner or an administrator grants them.
 */
export const networkDeclaration = z.strictObject({
  backend: origins.default([]),
  browser: origins.default([]),
});

/**
 * How a connector, an app that connects an external system, signs in there: each
 * person with their own account, or everyone with credentials the app holds.
 */
export const connectorKind = z.enum(["personal", "shared"]);

// The entrypoint through which an app offers personal connections.
const userConnectionEntrypoint = "UserConnection";

type DeclaredConnector = {
  connector?: z.infer<typeof connectorKind> | undefined;
  entrypoints?: readonly string[] | undefined;
};

/** Why a declared connector kind does not fit the entrypoints the app exports. */
export const connectorIssue = ({ connector, entrypoints }: DeclaredConnector) => {
  const personal = entrypoints?.includes(userConnectionEntrypoint) ?? false;

  if (connector === "personal" && !personal)
    return `A personal connector exports a ${userConnectionEntrypoint} entrypoint`;

  if (connector === "shared" && personal)
    return `A shared connector cannot export ${userConnectionEntrypoint}; declare "connector": "personal"`;

  return null;
};

/**
 * Whether a deployment is a connector. Apps deployed before the declaration
 * existed count as personal connectors when they offer personal connections.
 */
export const connectorOf = ({ connector, entrypoints }: DeclaredConnector) =>
  connector ?? (entrypoints?.includes(userConnectionEntrypoint) ? "personal" : null);

/** widefleet.jsonc: what an app needs from Widefleet beyond its Wrangler configuration. */
export const appDeclaration = z.strictObject({
  $schema: z.string().optional(),
  network: networkDeclaration.optional(),
  connector: connectorKind.optional(),
});

export const emptyNetworkPolicy = () => networkPolicy.parse({ backend: [], browser: [] });

export const networkSnapshot = z.strictObject({
  revision: z.number().int().nonnegative(),
  policy: networkPolicy,
});

export const networkChange = z.strictObject({
  target: z.enum(["backend", "browser"]),
  action: z.enum(["allow", "deny"]),
  origins: z.array(networkOrigin).min(1),
});

export const networkState = networkSnapshot.extend({
  appliedRevision: z.number().int().nonnegative().nullable(),
  state: z.enum(["saved", "pending", "active", "failed"]),
  error: z.string().nullable(),
  // Against the app's latest deployment: declared origins that are not allowed
  // yet, and allowed origins it no longer declares. Absent without a declaration.
  requested: networkPolicy.optional(),
  undeclared: networkPolicy.optional(),
});
