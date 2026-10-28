import { describe, expect, it } from "vitest";
import { executionLimits, executionOptions } from "./execution-limits.ts";

const profiles = {
  http: { cpuMs: 100, subRequests: 50 },
  connector: { cpuMs: 250, subRequests: 50 },
  cron: { cpuMs: 1000, subRequests: 200 },
  workflow: { cpuMs: 5000, subRequests: 500 },
  readiness: { cpuMs: 100, subRequests: 10 },
};

describe("Dynamic Worker execution policy", () => {
  it("preserves platform defaults for installations without a policy", () => {
    expect(executionOptions({}, "http")).toBeUndefined();
  });

  it("selects the current profile without retaining the first request's policy", () => {
    const environment = { WIDEFLEET_EXECUTION_LIMITS: JSON.stringify(profiles) };
    expect(executionOptions(environment, "readiness")).toEqual({ limits: profiles.readiness });
    expect(executionOptions(environment, "http")).toEqual({ limits: profiles.http });
    expect(executionOptions(environment, "cron")).toEqual({ limits: profiles.cron });
    expect(executionOptions(environment, "workflow")).toEqual({ limits: profiles.workflow });
    expect(executionOptions(environment, "connector")).toEqual({ limits: profiles.connector });

    const http = { cpuMs: 25, subRequests: 0 };
    environment.WIDEFLEET_EXECUTION_LIMITS = JSON.stringify({ ...profiles, http });
    expect(executionOptions(environment, "http")).toEqual({ limits: http });
  });

  it("rejects malformed or incomplete configured policies instead of removing limits", () => {
    for (const configuration of [
      "",
      "not-json",
      "null",
      "{}",
      JSON.stringify({ http: profiles.http }),
      JSON.stringify({ ...profiles, queue: profiles.cron }),
      JSON.stringify({ ...profiles, http: { cpuMs: 0, subRequests: 1 } }),
      JSON.stringify({ ...profiles, http: { cpuMs: -1, subRequests: 1 } }),
      JSON.stringify({ ...profiles, http: { cpuMs: 1.5, subRequests: 1 } }),
      JSON.stringify({ ...profiles, http: { cpuMs: 100, subRequests: -1 } }),
      JSON.stringify({ ...profiles, http: { cpuMs: 100, subRequests: 0.5 } }),
      JSON.stringify({ ...profiles, http: { cpuMs: "100", subRequests: 50 } }),
      JSON.stringify({ ...profiles, http: { cpuMs: 100, subrequests: 50 } }),
    ])
      expect(() =>
        executionOptions({ WIDEFLEET_EXECUTION_LIMITS: configuration }, "http"),
      ).toThrow();
  });

  it("requires finite resource limits", () => {
    expect(() =>
      executionLimits.parse({ ...profiles, http: { cpuMs: Infinity, subRequests: 50 } }),
    ).toThrow();
  });
});
