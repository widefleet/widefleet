import { readAnalyticsConfiguration } from "../src/lib/analytics-config.ts";

export const analyticsEnvironment = {
  PLATFORM_URL: "https://control.example.com",
  POSTHOG_PROJECT_TOKEN: "phc_synthetic",
  POSTHOG_ORIGIN: "https://control.example.com",
  POSTHOG_PROXY_PATH: "/analytics",
  POSTHOG_SESSION_REPLAY: "true",
  POSTHOG_SCOPE: "hosted",
} as const;

const configuration = readAnalyticsConfiguration(analyticsEnvironment);

if (!configuration) throw new Error("Missing synthetic analytics configuration");

export const analyticsConfiguration = configuration;
