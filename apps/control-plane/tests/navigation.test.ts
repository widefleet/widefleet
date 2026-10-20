import { describe, expect, it } from "vitest";
import { localDestination } from "../src/lib/server/navigation.ts";

describe("Local navigation destinations", () => {
  it.each([
    undefined,
    null,
    "",
    "apps",
    "https://external.example.test/apps",
    "//external.example.test/apps",
    "/\\external.example.test",
    "/\n/external.example.test",
    "/\t/external.example.test",
    "/\n/external.example.test:invalid",
    "/apps/..//external.example.test",
    "/apps/%2e%2e//external.example.test",
    "javascript:alert(1)",
  ])("falls back to the workspace for %j", (value) => {
    expect(localDestination(value)).toBe("/");
  });

  it.each([
    "/",
    "/apps/123?q=linked%20app&view=overview",
    "/apps/123#deployments",
    "/organizations?next=%2Fapps%2F123%3Fq%3Dlinked",
    "/apps?q=https%3A%2F%2Fexternal.example.test",
  ])("preserves local path, query and fragment in %s", (value) => {
    expect(localDestination(value)).toBe(value);
  });
});
