import { describe, expect, it } from "vitest";
import { appAccessChange } from "./app-access.ts";

describe("app access group restrictions", () => {
  it.each([
    ["finance,engineering"],
    ["finance\nengineering"],
    ["finance\u0000"],
    [""],
    ["finance", " finance "],
  ])("rejects ambiguous or duplicate group IDs %j", (...groups) => {
    expect(appAccessChange.safeParse({ revision: 0, groups }).success).toBe(false);
  });

  it("allows an explicit empty restriction and preserves IDs that require URL encoding", () => {
    expect(appAccessChange.parse({ revision: 3, groups: [] }).groups).toEqual([]);
    expect(
      appAccessChange.parse({ revision: 3, groups: ["team&allowed_groups=other"] }).groups,
    ).toEqual(["team&allowed_groups=other"]);
  });
});
