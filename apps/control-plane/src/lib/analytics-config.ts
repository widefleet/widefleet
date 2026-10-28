import { z } from "zod";

const origin = z.url().refine((value) => {
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

// Public ingestion settings only. Personal and administrative keys are never used.
export const analyticsEnvironmentSchema = z.object({
  POSTHOG_PROJECT_TOKEN: z.string().startsWith("phc_").optional(),
  POSTHOG_ORIGIN: origin.optional(),
  POSTHOG_PROXY_PATH: z
    .string()
    .regex(/^\/[a-zA-Z0-9_-]+$/)
    .optional(),
  POSTHOG_SESSION_REPLAY: z.enum(["true", "false"]).optional(),
  POSTHOG_SCOPE: z.string().min(1).optional(),
});

export type AnalyticsEnvironment = z.infer<typeof analyticsEnvironmentSchema>;

export const readAnalyticsConfiguration = (environment: AnalyticsEnvironment) => {
  if (!environment.POSTHOG_PROJECT_TOKEN || !environment.POSTHOG_ORIGIN) return null;

  return {
    projectToken: environment.POSTHOG_PROJECT_TOKEN,
    origin: new URL(environment.POSTHOG_ORIGIN).origin,
    proxyPath: environment.POSTHOG_PROXY_PATH ?? "/analytics",
    sessionReplay: environment.POSTHOG_SESSION_REPLAY === "true",
    scope: environment.POSTHOG_SCOPE ?? "installation",
    ingestOrigin: "https://eu.i.posthog.com",
    assetOrigin: "https://eu-assets.i.posthog.com",
    uiOrigin: "https://eu.posthog.com",
  };
};

export type AnalyticsConfiguration = NonNullable<ReturnType<typeof readAnalyticsConfiguration>>;
