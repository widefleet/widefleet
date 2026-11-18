import { describe, expect, it } from "vitest";
import {
  workflowEventPrompt,
  workflowQuery,
  workflowRequest,
  workflowRestartOptions,
} from "./workflows.ts";

describe("Workflow event prompts", () => {
  it("defaults to a confirmation without fields", () => {
    expect(workflowEventPrompt.parse({ message: "Send offer 42?" })).toEqual({
      message: "Send offer 42?",
      requestedSchema: { type: "object", properties: {} },
    });
  });

  it("accepts flat primitive forms", () => {
    const prompt = {
      message: "Overwrite contact?",
      requestedSchema: {
        type: "object",
        properties: {
          overwrite: { type: "boolean", title: "Overwrite", default: false },
          reason: { type: "string", maxLength: 200 },
          priority: { type: "string", enum: ["low", "high"] },
          count: { type: "integer", minimum: 1 },
        },
        required: ["overwrite"],
      },
    };

    expect(workflowEventPrompt.parse(prompt)).toEqual(prompt);
  });

  it.each([
    { message: "" },
    { message: "x", extra: true },
    { message: "x".repeat(4097) },
    { message: "x", requestedSchema: { type: "object", properties: { a: { type: "object" } } } },
    { message: "x", requestedSchema: { type: "object", properties: {}, required: ["missing"] } },
    {
      message: "x",
      requestedSchema: {
        type: "object",
        properties: Object.fromEntries(
          Array.from({ length: 33 }, (_, index) => [`f${index}`, { type: "boolean" }]),
        ),
      },
    },
    {
      message: "x",
      requestedSchema: {
        type: "object",
        properties: Object.fromEntries(
          Array.from({ length: 20 }, (_, index) => [
            `f${index}`,
            { type: "string", description: "d".repeat(1000) },
          ]),
        ),
      },
    },
  ])("rejects invalid prompts: %#", (prompt) => {
    expect(workflowEventPrompt.safeParse(prompt).success).toBe(false);
  });
});

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
