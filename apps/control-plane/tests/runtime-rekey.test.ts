import { describe, expect, it, vi } from "vitest";
import { createRuntimeRekey } from "../src/lib/server/runtime-rekey.ts";
import type { Principal } from "../src/lib/server/identity.ts";

const principal = (admin: boolean): Principal => ({
  id: "owner",
  name: "Owner",
  email: "owner@example.test",
  role: "owner",
  admin,
  creator: true,
  application: { organizationId: "widefleet", admin: true },
});

const page = { current: 1, rewritten: 2, unreadable: 0, conflicts: 0, cursor: "next" };

describe("runtime storage rewrite", () => {
  it("forwards one page for installation administrators", async () => {
    const request = vi.fn(async () => Response.json({ result: page }));

    expect(
      (await createRuntimeRekey(request).page(principal(true), { cursor: "start" })).unwrap(),
    ).toEqual(page);
    expect(request).toHaveBeenCalledWith({ cursor: "start" });
  });

  it("rejects other members before reaching the runtime", async () => {
    const request = vi.fn(async () => Response.json({ result: page }));
    const result = await createRuntimeRekey(request).page(principal(false), {});

    expect(result.isErr() && result.error).toMatchObject({ code: "FORBIDDEN" });
    expect(request).not.toHaveBeenCalled();
  });

  it("reports a runtime that cannot rewrite its storage", async () => {
    const failed = await createRuntimeRekey(async () => new Response(null, { status: 503 })).page(
      principal(true),
      {},
    );

    expect(failed.isErr() && failed.error.message).toBe(
      "The app runtime could not rewrite its storage (status 503)",
    );

    const missing = await createRuntimeRekey().page(principal(true), {});

    expect(missing.isErr() && missing.error).toMatchObject({ code: "CONFLICT" });
  });
});
