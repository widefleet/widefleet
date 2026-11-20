import { describe, expect, it } from "vitest";
import { companyDomains, maxCompanyDomains, parseCompanyDomains } from "./settings.ts";

describe("company email domains", () => {
  it("stores domains in Better Auth's canonical comma-separated form", () => {
    expect(companyDomains.parse(" Example.TEST , alias.example ")).toBe(
      "example.test,alias.example",
    );
    expect(companyDomains.parse("example.test")).toBe("example.test");
    expect(parseCompanyDomains("example.test, Alias.Example")).toEqual([
      "example.test",
      "alias.example",
    ]);
  });

  it.each([
    "",
    " , ",
    "example.test,https://alias.example",
    "example.test,*.alias.example",
    "example.test;alias.example",
    "example.test,EXAMPLE.test",
    Array.from({ length: maxCompanyDomains + 1 }, (_, index) => `d${index}.example`).join(","),
  ])("rejects %j", (value) => {
    expect(companyDomains.safeParse(value).success).toBe(false);
  });
});
