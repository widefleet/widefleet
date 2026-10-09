import { betterAuth } from "better-auth";
import { authenticationOptions } from "../src/lib/server/auth-options.ts";
import { configurationSchema } from "../src/lib/server/config.ts";

// Schema generation uses only plugin definitions and never connects to a service.
export const auth = betterAuth(
  authenticationOptions(
    configurationSchema.parse({
      DATABASE_URL: "postgres://unused:unused@127.0.0.1:1/unused",
      PLATFORM_URL: "http://localhost:3000",
      APP_DOMAIN: "apps.localhost",
      S3_ENDPOINT: "http://localhost:9000",
      S3_BUCKET: "artifacts",
      S3_ACCESS_KEY_ID: "schema-generation",
      S3_SECRET_ACCESS_KEY: "schema-generation",
      BETTER_AUTH_SECRET: "schema-generation-only-not-a-runtime-secret",
      ENTRA_TENANT_ID: "00000000-0000-4000-8000-000000000001",
      ENTRA_CLIENT_ID: "00000000-0000-4000-8000-000000000002",
      ENTRA_CLIENT_SECRET: "schema-generation",
      ADMIN_ENTRA_OBJECT_IDS: "00000000-0000-4000-8000-000000000003",
    }),
  ),
);
