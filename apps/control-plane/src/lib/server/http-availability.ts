import { organizationHttpAvailability, organizationHttpAvailabilityKey } from "@platform/contracts";

export const publishOrganizationHttpAvailability = async (
  storage: {
    get: (key: string) => Promise<string | null>;
    put: (key: string, value: string) => Promise<void>;
  },
  organizationId: string,
  blocked: boolean,
) => {
  const key = organizationHttpAvailabilityKey(organizationId);
  const value = await storage.get(key);

  const current =
    value === null ? false : organizationHttpAvailability.parse(JSON.parse(value)).blocked;

  // Compare with KV on every evaluation. A database copy cannot confirm whether
  // a previous publication arrived; stale KV reads converge on later runs.
  if (current !== blocked) await storage.put(key, JSON.stringify({ blocked }));
};
