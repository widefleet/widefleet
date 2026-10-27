import { organizationHttpAvailability, organizationHttpAvailabilityKey } from "@platform/contracts";
import type { ParentEnvironment } from "./types.ts";

export const readOrganizationAvailability = async (
  environment: ParentEnvironment,
  organizationId: string,
) => {
  if (environment["WIDEFLEET_HTTP_AVAILABILITY"] !== "kv") return { blocked: false };

  try {
    const value = await environment.AUTH_CONFIG.get(
      organizationHttpAvailabilityKey(organizationId),
    );

    return value === null
      ? { blocked: false }
      : organizationHttpAvailability.parse(JSON.parse(value));
  } catch {
    console.error("Organization availability could not be read");

    return null;
  }
};

export const requireOrganizationAvailability = async (
  environment: ParentEnvironment,
  organizationId: string,
) => {
  const availability = await readOrganizationAvailability(environment, organizationId);

  if (availability === null) throw new Error("Organization availability could not be read");

  if (availability.blocked) throw new Error("Organization execution is suspended");
};
