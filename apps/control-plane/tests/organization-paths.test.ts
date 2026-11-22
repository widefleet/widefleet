import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createOrganizationInput,
  organizationSlug,
  reservedOrganizationSlugs,
} from "@platform/contracts";
import { workspacePath } from "../src/lib/workspace-path.ts";

// Route groups such as `(auth)` do not appear in URLs, so their children are top-level pages.
const topLevelPages = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isDirectory()) return [];

    if (entry.name.startsWith("(")) return topLevelPages(join(directory, entry.name));

    return entry.name.startsWith("[") ? [] : [entry.name];
  });

describe("Organization paths", () => {
  it("reserves every top-level page name", () => {
    const pages = topLevelPages(join(import.meta.dirname, "../src/routes"));

    expect(
      pages.filter((page) => !reservedOrganizationSlugs.some((slug) => slug === page)),
    ).toEqual([]);
  });

  it("rejects reserved names for new organizations", () => {
    expect(createOrganizationInput.safeParse({ name: "Setup", slug: "setup" }).success).toBe(false);
    expect(createOrganizationInput.safeParse({ name: "Acme", slug: "acme" }).success).toBe(true);
  });

  it.each(["acme", "acme-labs", "a1"])("matches %s as an organization", (slug) => {
    expect(organizationSlug.safeParse(slug).data).toBe(slug);
  });

  it.each(["Acme", "favicon.ico", "_app", "-acme", "acme-", "acme--labs"])(
    "does not match %s as an organization",
    (segment) => {
      expect(organizationSlug.safeParse(segment).success).toBe(false);
    },
  );

  it("places workspace pages below the organization", () => {
    expect(workspacePath("acme")).toBe("/acme");
    expect(workspacePath("acme", "/apps/123?q=1#access")).toBe("/acme/apps/123?q=1#access");
  });
});
