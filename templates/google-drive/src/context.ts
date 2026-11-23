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
  // Keys the app uses but never reads; Widefleet keeps them in the runtime.
  WIDEFLEET_KEYS: {
    sign(name: string, data: string): Promise<string>;
    verify(name: string, data: string, signature: string): Promise<boolean>;
    encrypt(name: string, data: string): Promise<string>;
    decrypt(name: string, ciphertext: string): Promise<Uint8Array>;
  };
}

export interface Properties {
  caller: Caller | null;
}

export const callerId = async (identity: Caller) => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify([identity.issuer, identity.subject])),
  );

  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};
