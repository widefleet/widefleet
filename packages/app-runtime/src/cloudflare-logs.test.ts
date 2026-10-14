import { describe, expect, it } from "vitest";
import { cloudflareLogRecords } from "./cloudflare-logs.ts";

const props = {
  appId: crypto.randomUUID(),
  deploymentId: crypto.randomUUID(),
  buildId: "current-build",
};

const timestamp = Date.parse("2026-10-14T12:00:00Z");

const event = {
  logs: [],
  exceptions: [],
  eventTimestamp: timestamp,
  outcome: "ok",
  truncated: false,
};

describe("Cloudflare tail records", () => {
  it("attributes plain console records to the loader's app and deployment", () => {
    const [log] = cloudflareLogRecords(
      { ...event, logs: [{ timestamp, level: "warn", message: ["hello", { value: 42 }] }] },
      props,
      timestamp + 5000,
    );

    expect(log).toMatchObject({
      appId: props.appId,
      receivedTime: timestamp + 5000,
      eventTime: timestamp,
      record: {
        level: "warn",
        message: 'hello {"value":42}',
        buildId: props.buildId,
        deploymentId: props.deploymentId,
        receivedAt: String((timestamp + 5000) * 1000),
      },
    });
  });

  it("inherits request context within one invocation without trusting reported deployment or app IDs", () => {
    const records = cloudflareLogRecords(
      {
        ...event,
        logs: [
          { timestamp, level: "log", message: ["first"] },
          {
            timestamp,
            level: "log",
            message: [
              JSON.stringify({
                widefleet: 1,
                source: "server",
                kind: "request",
                message: "GET /test",
                appId: crypto.randomUUID(),
                deploymentId: crypto.randomUUID(),
                buildId: "spoofed",
                requestId: "request-1",
                traceId: "a".repeat(32),
                route: "/test",
              }),
            ],
          },
        ],
      },
      props,
    );

    for (const record of records)
      expect(record).toMatchObject({
        appId: props.appId,
        record: {
          deploymentId: props.deploymentId,
          buildId: props.buildId,
          requestId: "request-1",
          traceId: "a".repeat(32),
          route: "/test",
        },
      });
  });

  it("keeps old browser build attribution and ignores its claimed deployment", () => {
    const [log] = cloudflareLogRecords(
      {
        ...event,
        logs: [
          {
            timestamp,
            level: "error",
            message: [
              JSON.stringify({
                widefleet: 1,
                source: "browser",
                kind: "error",
                message: "browser failure",
                buildId: "older",
                deploymentId: props.deploymentId,
              }),
            ],
          },
        ],
      },
      props,
    );

    expect(log?.record).toMatchObject({
      source: "browser",
      buildId: "older",
      deploymentId: null,
      message: "browser failure",
    });
  });

  it("captures exceptions including stack and failures without an exception", () => {
    const [exception] = cloudflareLogRecords(
      {
        ...event,
        outcome: "exception",
        exceptions: [
          { timestamp, name: "Error", message: "failed", stack: "Error: failed\n at app.js:3:4" },
        ],
      },
      props,
    );

    expect(exception?.record).toMatchObject({
      kind: "span_error",
      source: "runtime",
      message: "Error: failed",
      stack: "Error: failed\n at app.js:3:4",
    });
    const [limit] = cloudflareLogRecords({ ...event, outcome: "exceededCpu" }, props);
    expect(limit?.record).toMatchObject({
      kind: "span_error",
      level: "error",
      message: "Worker execution failed: exceededCpu",
    });
  });

  it("bounds re-emitted records without losing their attribution or producing invalid JSON", () => {
    const message = "\u0001世界".repeat(80_000);

    const [log] = cloudflareLogRecords(
      { ...event, logs: [{ timestamp, level: "error", message: [message] }] },
      props,
    );

    expect(new TextEncoder().encode(JSON.stringify(log)).byteLength).toBeLessThan(256 * 1024);
    expect(log?.record.message).toContain("[truncated]");
    expect(log?.appId).toBe(props.appId);
  });

  it("makes native truncation visible and preserves ordinary malformed JSON", () => {
    const records = cloudflareLogRecords(
      { ...event, truncated: true, logs: [{ timestamp, level: "debug", message: ["{malformed"] }] },
      props,
    );

    expect(records.map((log) => log.record)).toMatchObject([
      { level: "debug", message: "{malformed" },
      { level: "warn", message: "Cloudflare truncated this invocation's logs" },
    ]);
  });
});
