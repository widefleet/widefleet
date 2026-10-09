import { z } from "zod";
import { companyIdentity } from "./company-identity.ts";
import { artifactStorageSchema } from "./storage/config.ts";

const telemetryUrl = z.url().refine((value) => {
  const url = new URL(value);

  return (
    ["http:", "https:"].includes(url.protocol) &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash &&
    url.pathname === "/"
  );
}, "Expected an HTTP(S) origin without credentials, path, query or fragment");

export const configurationSchema = z
  .object({
    DATABASE_URL: z.url(),
    PLATFORM_USAGE_REPORTING: z
      .enum(["true", "false", ""])
      .transform((value) => (value === "" ? undefined : value === "true"))
      .optional(),
    PLATFORM_CRASH_REPORTING: z
      .enum(["true", "false", ""])
      .transform((value) => (value === "" ? undefined : value === "true"))
      .optional(),
    CLICKHOUSE_URL: telemetryUrl.optional(),
    CLICKHOUSE_USER: z.string().min(1).default("widefleet_reader"),
    CLICKHOUSE_PASSWORD: z.string().default(""),
    OTEL_COLLECTOR_URL: telemetryUrl.default("http://otel-collector:4318"),
    PLATFORM_URL: z.url().transform((value, context) => {
      const url = new URL(value);

      const local =
        url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";

      if (
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.pathname !== "/" ||
        (url.protocol !== "https:" && !(local && url.protocol === "http:"))
      ) {
        context.addIssue({
          code: "custom",
          message: "Expected an HTTPS origin, or an HTTP loopback origin for local development",
        });

        return z.NEVER;
      }

      return url.origin;
    }),
    APP_DOMAIN: z.string().regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/),
    APP_HTTPS_PORT: z.coerce.number().int().min(1).max(65535).default(443),
    BETTER_AUTH_SECRET: z.string().min(32).optional(),
    PLATFORM_STATE_DIRECTORY: z.string().min(1).default("/var/lib/widefleet"),
    PLATFORM_AUTH_DIRECTORY: z.string().min(1).default("/var/lib/widefleet/auth"),
    PLATFORM_CONFIG_DIRECTORY: z.string().min(1).optional(),
    TLS_MODE: z.enum(["provided", "cloudflare"]).default("provided"),
    ACME_EMAIL: z.email().optional(),
    ACME_ENVIRONMENT: z.enum(["production", "staging"]).default("production"),
    PLATFORM_BOOTSTRAP_FILE: z.string().min(1).optional(),
    PLATFORM_ENCRYPTION_KEY: z
      .union([z.string().min(32), z.literal("")])
      .optional()
      .transform((value) => value || undefined),
    PLATFORM_ENCRYPTION_KEY_FILE: z.string().min(1).optional(),
    IDENTITY: companyIdentity.nullable().default(null),
    LOCAL_PASSWORD_ENABLED: z.boolean().default(false),
  })
  .and(artifactStorageSchema);

export const readConfiguration = () => configurationSchema.parse(process.env);

export type Configuration = ReturnType<typeof readConfiguration>;
