import { describe, expect, it } from "vitest";
import { workflowQuery, workflowRequest, workflowRestartOptions } from "./workflows.ts";

describe("Workflow restart requests", () => {
  const request = { action: "restart", workflow: "example", id: "run-1" };

  it("accepts full restarts and normalizes selectors consistently for bindings and management", () => {
    expect(workflowRequest.parse(request)).toEqual(request);
    const options = { from: { name: "aggregate" } };
    expect(workflowRestartOptions.parse(options)).toEqual({
      from: { name: "aggregate", count: 1, type: "do" },
    });
    expect(workflowRequest.parse({ ...request, ...options })).toEqual({
      ...request,
      ...workflowRestartOptions.parse(options),
    });
    expect(workflowQuery.safeParse({ ...request, ...options }).success).toBe(false);
  });

  it.each([
    { name: "aggregate", count: 0 },
    { name: "aggregate", count: 1.5 },
    { name: "aggregate", type: "sleepUntil" },
    { name: "aggregate", extra: true },
    { name: "a\nb" },
    { name: "a".repeat(257) },
    { step: "aggregate" },
  ])("rejects invalid targets in both interfaces: %j", (from) => {
    expect(workflowRestartOptions.safeParse({ from }).success).toBe(false);
    expect(workflowRequest.safeParse({ ...request, from }).success).toBe(false);
  });
});
