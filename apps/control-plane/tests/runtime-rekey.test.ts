import { describe, expect, it, vi } from "vitest";
import { rekeyRuntime } from "../src/lib/server/runtime-rekey.ts";

const page = (counts: { rewritten?: number; current?: number }, cursor: string | null) => ({
  result: { current: 0, rewritten: 0, unreadable: 0, conflicts: 0, ...counts, cursor },
});

describe("runtime storage rewrite", () => {
  it("drives every page and adds up the counts", async () => {
    const pages = [page({ rewritten: 3 }, "next"), page({ rewritten: 1, current: 2 }, null)];
    const request = vi.fn(async () => Response.json(pages.shift()));

    expect(await rekeyRuntime(request)).toEqual({
      current: 2,
      rewritten: 4,
      unreadable: 0,
      conflicts: 0,
    });
    expect(request.mock.calls).toEqual([["{}"], ['{"cursor":"next"}']]);
  });

  it("reports a runtime that cannot rewrite its storage", async () => {
    await expect(rekeyRuntime(async () => new Response(null, { status: 503 }))).rejects.toThrow(
      "The app runtime could not rewrite its storage (status 503)",
    );
  });
});
