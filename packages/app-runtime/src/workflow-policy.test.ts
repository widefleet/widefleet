import { describe, expect, it } from "vitest";
import { workflowStepPolicy } from "./workflow-policy.ts";

const limits = JSON.stringify({ maxRetries: 10, minRetryDelayMs: 1000, maxTimeoutMs: 600_000 });

describe("Workflow execution policy", () => {
  it("caps retry storms and long attempts in the parent", () => {
    expect(
      workflowStepPolicy({ retries: { limit: 10_000, delay: 0 }, timeout: "1 year" }, limits),
    ).toEqual({
      retries: { limit: 10, delay: 1000, backoff: "exponential" },
      timeout: 600_000,
    });
  });

  it("retains stricter app settings, backoff and sensitive output", () => {
    expect(
      workflowStepPolicy(
        {
          retries: { limit: 0, delay: "2 minutes", backoff: "linear" },
          timeout: "30 seconds",
          sensitive: "output",
        },
        limits,
      ),
    ).toEqual({
      retries: { limit: 0, delay: 120_000, backoff: "linear" },
      timeout: 30_000,
      sensitive: "output",
    });
  });

  it("bounds native defaults and leaves unconfigured installations unchanged", () => {
    expect(workflowStepPolicy({}, limits)).toEqual({
      retries: { limit: 5, delay: 10_000, backoff: "exponential" },
      timeout: 600_000,
    });
    expect(workflowStepPolicy({}, undefined)).toEqual({});
  });

  it("rejects malformed policy and unrecognized duration formats", () => {
    expect(() => workflowStepPolicy({}, "invalid")).toThrow();
    expect(() => workflowStepPolicy({}, '{"maxRetries":-1}')).toThrow();
    expect(() => workflowStepPolicy({ timeout: -1 }, limits)).toThrow();
  });
});
