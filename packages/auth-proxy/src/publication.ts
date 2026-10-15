import { appAccessSnapshot } from "@platform/contracts";
import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import { z } from "zod";
import { authConfiguration, type AuthConfiguration } from "./configuration.ts";

export const authHostname = z.string().regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/);

export const authRoute = z.strictObject({
  appId: z.uuid(),
  access: appAccessSnapshot,
  upstream: z
    .url()
    .refine((value) => {
      const url = new URL(value);

      return (
        ["http:", "https:"].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        url.pathname === "/"
      );
    })
    .optional(),
});

const publication = z.strictObject({
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  ciphertext: z.string(),
});

export const configurationRevision = async (input: AuthConfiguration) => {
  const data = new TextEncoder().encode(JSON.stringify(authConfiguration.parse(input)));
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", data));

  return Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("");
};

export const encodeConfiguration = async (key: string, input: AuthConfiguration) => {
  const configuration = authConfiguration.parse(input);

  return JSON.stringify({
    revision: await configurationRevision(configuration),
    ciphertext: await symmetricEncrypt({ key, data: JSON.stringify(configuration) }),
  });
};

export const decodeConfiguration = async (key: string, value: string) => {
  const stored = publication.parse(JSON.parse(value));

  const configuration = authConfiguration.parse(
    JSON.parse(await symmetricDecrypt({ key, data: stored.ciphertext })),
  );

  if ((await configurationRevision(configuration)) !== stored.revision)
    throw new Error("Auth configuration revision does not match its contents");

  return { revision: stored.revision, configuration };
};

export const authControlPath = "/.well-known/widefleet/auth";

export const authRouteKey = (hostname: string) => `apps/${authHostname.parse(hostname)}`;
