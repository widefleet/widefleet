import { organizationIdentifier } from "@platform/contracts";
import { z } from "zod";

export const workloadLifetime = 300;

export const workloadRotationInterval = 30 * 24 * 60 * 60;

export const workloadKeyGrace = workloadLifetime + 60;

export const workloadConfigurationKey = "workload/configuration.json";

export const workloadControlPath = "/.well-known/widefleet/workload-configuration";

// A distinct cron expression keeps installation extension schedules independent.
export const workloadPublicationCron = "0-59 * * * *";

export const workloadAudience = z
  .string()
  .min(1)
  .max(2048)
  .regex(/^[!-~]+$/);

export const workloadToken = z.strictObject({
  token: z.string().min(1),
  expiresAt: z.number().int(),
});

export const workloadConfiguration = z.strictObject({
  issuer: z.url().refine((value) => {
    const url = new URL(value);

    return (
      url.protocol === "https:" &&
      url.pathname === "/workload" &&
      !url.search &&
      !url.hash &&
      !url.username &&
      !url.password
    );
  }),
  organizations: z.array(organizationIdentifier),
});
