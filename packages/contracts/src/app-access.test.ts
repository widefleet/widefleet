import { describe, expect, it } from "vitest";
import { appAccessGroups, appAccessChange } from "./app-access.ts";

describe("app access group restrictions", () => {
  it.each([
    ["finance,engineering"],
    ["finance\nengineering"],
    ["finance\u0000"],
    [""],
    ["finance", " finance "],
  ])("rejects ambiguous or duplicate group IDs %j", (...groups) => {
    expect(appAccessGroups.safeParse(groups).success).toBe(false);
  });

  it("requires an explicit audience choice and preserves literal IDs", () => {
    expect(appAccessChange.parse({ revision: 3, allAuthenticated: false }).allAuthenticated).toBe(
      false,
    );
    expect(appAccessChange.safeParse({ revision: 3 }).success).toBe(false);
    expect(appAccessGroups.parse(["team&allowed_groups=other"])).toEqual([
      "team&allowed_groups=other",
    ]);
  });
});
