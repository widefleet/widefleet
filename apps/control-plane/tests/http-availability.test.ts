import { describe, expect, it, vi } from "vitest";
import { organizationHttpAvailabilityKey } from "@platform/contracts";
import { publishOrganizationHttpAvailability } from "../src/lib/server/http-availability.ts";

const fixture = () => {
  const values = new Map<string, string>();

  const storage = {
    get: vi.fn(async (key: string) => values.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      values.set(key, value);
    }),
  };

  return { values, storage };
};

describe("Organization HTTP availability in KV", () => {
  it("writes only changed organization status and preserves unrelated configuration", async () => {
    const { values, storage } = fixture();
    values.set("organizations/example/configuration", "auth configuration");
    await publishOrganizationHttpAvailability(storage, "example", false);
    expect(storage.put).not.toHaveBeenCalled();
    await publishOrganizationHttpAvailability(storage, "example", true);
    await publishOrganizationHttpAvailability(storage, "example", true);
    expect(storage.put).toHaveBeenCalledTimes(1);
    await publishOrganizationHttpAvailability(storage, "example", false);
    await publishOrganizationHttpAvailability(storage, "example", false);
    expect(storage.put).toHaveBeenCalledTimes(2);
    expect(values.get(organizationHttpAvailabilityKey("example"))).toBe('{"blocked":false}');
    expect(values.get("organizations/example/configuration")).toBe("auth configuration");
  });

  it("repairs a failed write on the next comparison without recording pending state", async () => {
    const { values, storage } = fixture();
    storage.put.mockRejectedValueOnce(new Error("Synthetic KV write failure"));
    await expect(publishOrganizationHttpAvailability(storage, "example", true)).rejects.toThrow();
    expect(storage.put).toHaveBeenCalledTimes(1);
    await publishOrganizationHttpAvailability(storage, "example", true);
    expect(values.get(organizationHttpAvailabilityKey("example"))).toBe('{"blocked":true}');
  });

  it("converges after stale reads and a delayed old write", async () => {
    const { values, storage } = fixture();
    const key = organizationHttpAvailabilityKey("example");
    values.set(key, '{"blocked":true}');
    storage.get.mockResolvedValueOnce(null);
    await publishOrganizationHttpAvailability(storage, "example", false);
    expect(storage.put).not.toHaveBeenCalled();
    await publishOrganizationHttpAvailability(storage, "example", false);
    expect(values.get(key)).toBe('{"blocked":false}');
    // An earlier timed-out write can still arrive; a fresh comparison repairs it.
    values.set(key, '{"blocked":true}');
    await publishOrganizationHttpAvailability(storage, "example", false);
    expect(values.get(key)).toBe('{"blocked":false}');
  });

  it("does not turn failed or malformed reads into an unblocked status", async () => {
    const { values, storage } = fixture();
    storage.get.mockRejectedValueOnce(new Error("Synthetic KV read failure"));
    await expect(publishOrganizationHttpAvailability(storage, "example", false)).rejects.toThrow();
    values.set(organizationHttpAvailabilityKey("example"), '{"blocked":"false"}');
    await expect(publishOrganizationHttpAvailability(storage, "example", false)).rejects.toThrow();
    expect(storage.put).not.toHaveBeenCalled();
  });
});
