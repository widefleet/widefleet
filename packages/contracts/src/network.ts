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
});
