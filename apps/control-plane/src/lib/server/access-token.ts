import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from "jose";
import { z } from "zod";
import { apiResource } from "./auth-options.ts";
import { readAuthenticationReference } from "./authentication-context.ts";
import type { Configuration } from "./config.ts";

const claims = z.object({
  sub: z.string().min(1),
  scope: z.string(),
  reference_id: z.string(),
  exp: z.number(),
  iat: z.number(),
  jti: z.string().optional(),
});

export const verifyAccessToken = async (
  token: string,
  keys: JSONWebKeySet,
  configuration: Configuration,
) => {
  const { payload } = await jwtVerify(token, createLocalJWKSet(keys), {
    issuer: `${configuration.PLATFORM_URL}/api/auth`,
    audience: apiResource(configuration),
    algorithms: ["EdDSA"],
    requiredClaims: ["exp", "iat", "sub", "scope"],
  });

  const verified = claims.parse(payload);

  const authority = readAuthenticationReference(verified.sub, verified.reference_id);

  if (!authority) throw new Error("Invalid sign-in context; sign in again");

  return { ...verified, authority };
};
