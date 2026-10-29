import { organizationHttpAvailability, organizationHttpAvailabilityKey } from "@platform/contracts";
import { authRoute, authRouteKey } from "@platform/auth-proxy/publication";
import type { ParentEnvironment } from "./types.ts";

// Identity comes from the parent's bindings, never from resource-call arguments.
export const readExecutionAvailability = async (
  environment: ParentEnvironment,
  identity: { appId: string; hostname: string } | { organizationId: string },
) => {
  if (environment["WIDEFLEET_HTTP_AVAILABILITY"] !== "kv") return { blocked: false };

  let organizationId;

  if ("organizationId" in identity) organizationId = identity.organizationId;
  else {
    const value = await environment.AUTH_CONFIG.get(authRouteKey(identity.hostname));

    if (value === null) throw new Error("Workflow app organization is not published");
    const route = authRoute.parse(JSON.parse(value));

    if (route.appId !== identity.appId)
      throw new Error("Workflow app authorization is being updated");
    organizationId = route.organizationId;
  }

  const availability = await readOrganizationAvailability(environment, organizationId);

  if (availability === null) throw new Error("Organization availability could not be read");

  return availability;
};

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
