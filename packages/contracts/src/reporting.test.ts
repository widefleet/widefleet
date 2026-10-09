import { describe, expect, it } from "vitest";
import { reportingError, sanitizeReportingError } from "./reporting.ts";

describe("Vendor error reports", () => {
  it("keeps Widefleet locations and removes messages, domains and private paths", () => {
    const error = new TypeError("Token secret-123 for person@example.test");

    error.stack = [
      error.toString(),
      "    at execute (/home/private-company/apps/control-plane/src/lib/server/jobs.ts:12:3)",
      "    at client (https://private.example.test/_app/immutable/chunks/control.ABCD.js:5:9)",
      "    at customer (/home/private-company/customer/app.js:1:2)",
      "    at dependency (/home/private-company/node_modules/sdk/index.js:42:1)",
      "    at malicious (/apps/control-plane/src/../../secret.js:2:4)",
    ].join("\n");

    const report = sanitizeReportingError(error);

    expect(report).toEqual({
      type: "TypeError",
      frames: [
        {
          filename: "apps/control-plane/src/lib/server/jobs.ts",
          function: "execute",
          lineno: 12,
          colno: 3,
        },
        {
          filename: "_app/immutable/chunks/control.ABCD.js",
          function: "client",
          lineno: 5,
          colno: 9,
        },
      ],
    });
    expect(JSON.stringify(report)).not.toMatch(/secret|example|private|customer/);
  });

  it("rejects arbitrary exception properties and caps the stack", () => {
    expect(reportingError.safeParse({ type: "Error", frames: [], message: "secret" }).success).toBe(
      false,
    );

    const error = new Error("private");

    error.name = "private customer name";
    error.stack = `Error\n${" at /apps/control-plane/src/lib/server/jobs.ts:12:3\n".repeat(100)}`;
    expect(sanitizeReportingError(error).type).toBe("Error");
    expect(sanitizeReportingError(error).frames).toHaveLength(20);
  });
});
