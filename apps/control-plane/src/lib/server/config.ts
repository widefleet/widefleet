import { z } from "zod";
import { analyticsEnvironmentSchema } from "../analytics-config.ts";
import { artifactStorageSchema } from "./storage/config.ts";
import { socialSignInConfiguration } from "./social-sign-in.ts";

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

// Better Auth's own format: comma-separated "<version>:<secret>" entries, with
// whitespace around versions and secrets ignored as Better Auth ignores it.
// Checked here as Better Auth checks it, so a deployment fails before it starts.
const betterAuthSecrets = z
  .string()
  .transform((value) => value.split(","))
  .pipe(
    z.array(
      z
        .string()
        .regex(/^\s*\d+\s*:/, "Start each entry with <version>:")
        .transform((entry) => {
          const separator = entry.indexOf(":");

          return {
            version: Number(entry.slice(0, separator)),
            value: entry.slice(separator + 1).trim(),
          };
        })
        .pipe(
          z.object({
            version: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
            value: z.string().min(32),
          }),
        ),
    ),
  )
  .refine(
    (secrets) => new Set(secrets.map(({ version }) => version)).size === secrets.length,
    "Use each version once",
  );

export const runtimeConfigurationSchema = z.object({
  ...socialSignInConfiguration.shape,
  ...analyticsEnvironmentSchema.shape,
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
  // Better Auth's versioned secrets, current first. Values written before
  // versions still open with BETTER_AUTH_SECRET. Empty counts as unset, as for
  // Better Auth, which reads the variable itself when the option is unset.
  BETTER_AUTH_SECRETS: z
    .string()
    .optional()
    .transform((value) => value || undefined)
    .pipe(betterAuthSecrets.optional()),
  GITHUB_TOKEN: z.string().trim().optional(),
  PLATFORM_STATE_DIRECTORY: z.string().min(1).default("/var/lib/widefleet"),
  PLATFORM_APP_RUNTIME_URL: telemetryUrl.default("http://runtime:8080"),
  // The app builder for one-click template installs, on a private network.
  PLATFORM_APP_BUILDER_URL: telemetryUrl.optional(),
  PLATFORM_RUNTIME_DIRECTORY: z.string().min(1).default("/var/lib/widefleet/runtime"),
  PLATFORM_CONFIG_DIRECTORY: z.string().min(1).optional(),
  TLS_MODE: z.enum(["provided", "cloudflare"]).default("provided"),
  ACME_EMAIL: z.email().optional(),
  ACME_ENVIRONMENT: z.enum(["production", "staging"]).default("production"),
  PLATFORM_BOOTSTRAP_FILE: z.string().min(1).optional(),
  // Parsed by the secret encryption service, so errors never repeat key material.
  PLATFORM_ENCRYPTION_KEYS: z
    .string()
    .optional()
    .transform((value) => value?.trim() || undefined),
  PLATFORM_ENCRYPTION_KEYS_FILE: z.string().min(1).optional(),
  PLATFORM_SSO_TRUST_PROVIDER: z
    .enum(["true", "false", ""])
    .default("false")
    .transform((value) => value === "true"),
  PLATFORM_SSO_ALLOW_EMAIL_ACCOUNT_LINKING: z
    .enum(["true", "false", ""])
    .default("false")
    .transform((value) => value === "true"),
  LOGIN_CODE_DELIVERY: z.enum(["email", "console"]).default("email"),
});

export const configurationSchema = runtimeConfigurationSchema.and(artifactStorageSchema);

export const readConfiguration = () => configurationSchema.parse(process.env);

export type Configuration = z.infer<typeof runtimeConfigurationSchema> & {
  ARTIFACT_STORAGE_PROVIDER: "s3" | "azure" | "gcs" | "r2";
};
