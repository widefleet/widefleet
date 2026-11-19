import { afterEach, describe, expect, it, vi } from "vitest";
import { answerValue, initialValue } from "./fields.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Input form fields", () => {
  it("fills defaults and leaves empty optional fields out", () => {
    expect(initialValue({ type: "boolean" })).toBe(false);
    expect(initialValue({ type: "integer", default: 2 })).toBe("2");
    expect(answerValue({ type: "integer" }, "3")).toBe(3);
    expect(answerValue({ type: "number" }, "")).toBeUndefined();
    expect(answerValue({ type: "string" }, "")).toBeUndefined();
    expect(answerValue({ type: "boolean" }, true)).toBe(true);
  });

  it("shows date-time defaults in local time and keeps an unchanged default's instant", () => {
    vi.stubEnv("TZ", "America/New_York");
    // 06:30 UTC is the second 01:30 on the day daylight saving ends.
    const field = { type: "string", format: "date-time", default: "2026-11-01T06:30:00Z" } as const;
    const shown = initialValue(field);

    expect(shown).toBe("2026-11-01T01:30:00");
    expect(answerValue(field, shown)).toBe("2026-11-01T06:30:00Z");
    expect(answerValue(field, "2026-11-02T09:00")).toBe("2026-11-02T14:00:00.000Z");
  });
});
