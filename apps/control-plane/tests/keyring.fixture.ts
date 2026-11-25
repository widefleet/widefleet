import { randomBytes } from "node:crypto";
import { z } from "zod";

/** A synthetic symmetric JWK; random key material unless `k` is given. */
export const keyVersion = (kid: string, k = randomBytes(32).toString("base64url")) => ({
  kty: "oct",
  kid,
  k,
});

/** Serializes keys as the JWK Set that PLATFORM_ENCRYPTION_KEYS holds, active key first. */
export const keySet = (...keys: ReturnType<typeof keyVersion>[]) => JSON.stringify({ keys });

/** Reads the keys of a JWK Set, such as the environment's or a generated file. */
export const keysOf = (text: string) =>
  z
    .object({ keys: z.array(z.object({ kty: z.string(), kid: z.string(), k: z.string() })) })
    .parse(JSON.parse(text)).keys;
