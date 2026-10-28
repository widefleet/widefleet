import { connectorCaller } from "@platform/contracts";
import { z } from "zod";

const assertion = z.strictObject({
  purpose: z.literal("widefleet-connector-caller/v1"),
  appId: z.uuid(),
  caller: connectorCaller,
  expiresAt: z.number().int(),
});

const encode = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

const decode = (value: string) =>
  Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), (character) =>
    character.charCodeAt(0),
  );

const key = (secret: string) =>
  crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(z.string().min(32).parse(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );

// The child isolate can carry this short-lived assertion but cannot change its
// principal or use it through another app's connector grant. SSO cookies never enter it.
export const signConnectorCaller = async (
  secret: string,
  appId: string,
  caller: z.infer<typeof connectorCaller>,
) => {
  const value = new TextEncoder().encode(
    JSON.stringify(
      assertion.parse({
        purpose: "widefleet-connector-caller/v1",
        appId,
        caller,
        expiresAt: Date.now() + 300_000,
      }),
    ),
  );

  const signature = await crypto.subtle.sign("HMAC", await key(secret), value);

  return `${encode(value)}.${encode(new Uint8Array(signature))}`;
};

export const verifyConnectorCaller = async (
  secret: string,
  appId: string,
  organizationId: string,
  proof: string,
) => {
  const [payload, signature] = z
    .tuple([z.string().min(1), z.string().min(1)])
    .parse(proof.split("."));

  const value = decode(payload);

  if (!(await crypto.subtle.verify("HMAC", await key(secret), decode(signature), value)))
    throw new Error("Invalid connector caller");
  const result = assertion.parse(JSON.parse(new TextDecoder().decode(value)));

  if (
    result.appId !== appId ||
    result.caller.organizationId !== organizationId ||
    result.expiresAt <= Date.now()
  )
    throw new Error("Connector caller is expired or belongs to another app");

  return result.caller;
};
