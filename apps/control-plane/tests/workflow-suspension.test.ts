import { describe, expect, it, vi } from "vitest";
import { reconcileWorkflowSuspension } from "../src/lib/server/workflow-suspension.ts";

describe("Workflow suspension reconciliation", () => {
  it("visits every batch after a failed call and sends no suspension decision", async () => {
    const ids = Array.from({ length: 23 }, () => crypto.randomUUID());

    const runtime = {
      reconcileWorkflows: vi
        .fn<(organizationId: string, appIds: string[]) => Promise<void>>()
        .mockRejectedValueOnce(new Error("Unavailable runtime"))
        .mockResolvedValue(undefined),
    };

    await expect(reconcileWorkflowSuspension(runtime, "fixture", ids)).rejects.toThrow(
      "Workflow suspension reconciliation failed",
    );
    expect(runtime.reconcileWorkflows.mock.calls).toEqual([
      ["fixture", ids.slice(0, 10)],
      ["fixture", ids.slice(10, 20)],
      ["fixture", ids.slice(20)],
    ]);
    await reconcileWorkflowSuspension(runtime, "fixture", ids);
    expect(runtime.reconcileWorkflows).toHaveBeenCalledTimes(6);
  });

  it("rejects a runtime without reconciliation support", async () => {
    const runtime = { reconcileWorkflows: vi.fn().mockRejectedValue(new Error("No such method")) };
    await expect(
      reconcileWorkflowSuspension(runtime, "fixture", [crypto.randomUUID()]),
    ).rejects.toThrow();
  });

  it("bounds a stalled batch and still schedules the remaining apps", async () => {
    vi.useFakeTimers();

    try {
      const ids = Array.from({ length: 11 }, () => crypto.randomUUID());

      const runtime = {
        reconcileWorkflows: vi
          .fn<(organizationId: string, appIds: string[]) => Promise<void>>()
          .mockImplementationOnce(() => new Promise(() => {}))
          .mockResolvedValue(undefined),
      };

      const result = expect(reconcileWorkflowSuspension(runtime, "fixture", ids)).rejects.toThrow(
        "Workflow suspension reconciliation failed",
      );

      await vi.advanceTimersByTimeAsync(10_000);
      await result;
      expect(runtime.reconcileWorkflows).toHaveBeenLastCalledWith("fixture", [ids[10]]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
