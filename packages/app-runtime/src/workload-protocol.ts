import { organizationIdentifier } from "@platform/contracts";
import { z } from "zod";

export const workloadAudience = z
  .string()
  .min(1)
  .max(2048)
  .regex(/^[!-~]+$/);

export const workloadTokenPath = "/api/workload/token";

export const workloadLifetime = 300;

export const workloadToken = z.strictObject({
  token: z.string().min(1),
  expiresAt: z.number().int(),
});

const assertion = z.strictObject({
  purpose: z.literal("widefleet-workload-request/v1"),
  appId: z.uuid(),
  organizationId: organizationIdentifier,
  audience: workloadAudience,
  issuedAt: z.number().int(),
  expiresAt: z.number().int(),
});

const key = (secret: string) =>
  crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(z.string().min(32).parse(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );

const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

const decode = (value: string) =>
  Uint8Array.from(atob(value), (character) => character.charCodeAt(0));

// This proof stays between the trusted runtime and control plane. It is not a
// workload token and cannot be verified with the public JWT signing keys.
export const signWorkloadRequest = async (
  secret: string,
  identity: { appId: string; organizationId: string },
  audience: string,
) => {
  const issuedAt = Math.floor(Date.now() / 1000);

  const payload = new TextEncoder().encode(
    JSON.stringify(
      assertion.parse({
        ...identity,
        purpose: "widefleet-workload-request/v1",
        audience,
        issuedAt,
        expiresAt: issuedAt + 30,
      }),
    ),
  );

  const signature = await crypto.subtle.sign("HMAC", await key(secret), payload);

  return `${encode(payload)}.${encode(new Uint8Array(signature))}`;
};

export const verifyWorkloadRequest = async (secret: string, proof: string) => {
  const [body, signature] = z
    .tuple([z.string().min(1), z.string().min(1)])
    .parse(z.string().max(8192).parse(proof).split("."));

  const payload = decode(body);

  if (!(await crypto.subtle.verify("HMAC", await key(secret), decode(signature), payload)))
    throw new Error("Invalid runtime assertion");
  const value = assertion.parse(JSON.parse(new TextDecoder().decode(payload)));
  const now = Math.floor(Date.now() / 1000);

  if (
    value.expiresAt <= now ||
    value.issuedAt > now + 5 ||
    value.expiresAt - value.issuedAt > 30 ||
    value.expiresAt <= value.issuedAt
  )
    throw new Error("Expired runtime assertion");

  return value;
};
