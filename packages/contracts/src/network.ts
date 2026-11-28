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

/** widefleet.jsonc: what an app needs from Widefleet beyond its Wrangler configuration. */
export const appDeclaration = z.strictObject({
  $schema: z.string().optional(),
  network: networkDeclaration.optional(),
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

/** Applies the current lists again after a failed activation, without changing them. */
export const networkRetry = z.strictObject({ action: z.literal("retry") });

/** What a hosted network command applies: a change to the lists or a retry. */
export const networkUpdate = z.union([networkChange, networkRetry]);

export const networkState = networkSnapshot.extend({
  appliedRevision: z.number().int().nonnegative().nullable(),
  state: z.enum(["saved", "pending", "active", "failed"]),
  error: z.string().nullable(),
  // Against the app's latest deployment: declared origins that are not allowed
  // yet, and allowed origins it no longer declares. Absent without a declaration.
  requested: networkPolicy.optional(),
  undeclared: networkPolicy.optional(),
});
