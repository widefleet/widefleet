import type { BetterAuthOptions } from "better-auth";
import { z } from "zod";

export const caller = z.object({
  issuer: z.string().min(1),
  subject: z.string().min(1),
  name: z.string(),
});

export type Caller = z.infer<typeof caller>;

export interface Environment {
  DB: D1Database;
  WIDEFLEET_ORIGIN: string;
  WIDEFLEET_SECRETS: { get(name: string): Promise<string> };
}

export interface Properties {
  caller: Caller | null;
}

export interface Provider {
  id: "microsoft";
  name: string;
  description: string;
  setup: string;
  clientId: string;
  clientSecret: string;
  subject: z.ZodType<string>;
  permission?: string;
  socialProviders: (
    clientId: string,
    clientSecret: string,
  ) => NonNullable<BetterAuthOptions["socialProviders"]>;
}

export const callerId = async (identity: Caller) => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify([identity.issuer, identity.subject])),
  );

  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};
