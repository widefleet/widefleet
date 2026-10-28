import { z } from "zod";

export const caller = z.strictObject({
  organizationId: z.string().min(1),
  issuer: z.url(),
  subject: z.string().min(1),
  name: z.string(),
});

export const properties = z.strictObject({ caller });

export type Properties = z.infer<typeof properties>;

export interface Environment {
  DB: D1Database;
  WIDEFLEET_SECRETS: { get(name: string): Promise<string> };
  CONNECTOR_ORIGIN: string;
  CONNECTOR_BASE_PATH?: string;
  APP_ORIGINS?: string;
  PROVIDER_ORIGIN: string;
  PROVIDER_API_ORIGIN: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_SCOPES: string;
}

export const basePath = (environment: Environment) =>
  environment.CONNECTOR_BASE_PATH ?? "/connector";

export const appOrigins = (environment: Environment) =>
  (environment.APP_ORIGINS ?? environment.CONNECTOR_ORIGIN)
    .split(" ")
    .map((origin) => new URL(origin).origin);

export const callerKey = async (identity: z.infer<typeof caller>) => {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      JSON.stringify([identity.organizationId, identity.issuer, identity.subject]),
    ),
  );

  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
};
