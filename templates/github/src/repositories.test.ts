import { describe, expect, it } from "vitest";
import { filePath, hasNextPage, readIssues } from "./repositories.ts";

describe("GitHub repository requests", () => {
  it("keeps file paths and revisions in their respective URL components", () => {
    const path = filePath({
      owner: "example",
      repository: "project",
      path: "docs/file #1.md",
      ref: "feature/a&b",
    });

    const url = new URL(path, "https://api.github.com");
    expect(url.pathname).toBe("/repos/example/project/contents/docs/file%20%231.md");
    expect(url.searchParams.get("ref")).toBe("feature/a&b");
    expect(() => filePath({ owner: "example", repository: "..", path: "README.md" })).toThrow();
    expect(() =>
      filePath({ owner: "example", repository: "project", path: "../README.md" }),
    ).toThrow();
  });

  it("retains next-page information when an issues page contains only pull requests", () => {
    const values = [
      {
        id: 1,
        number: 1,
        title: "Change",
        state: "open",
        html_url: "https://github.com/example/project/pull/1",
        user: null,
        created_at: "2026-01-01",
        updated_at: "2026-01-01",
        pull_request: { url: "https://api.github.com/repos/example/project/pulls/1" },
      },
    ];

    expect(readIssues(values)).toEqual([]);
    expect(
      hasNextPage(
        new Headers({
          link: '<https://api.github.com/repos/example/project/issues?page=2>; rel="next"',
        }),
      ),
    ).toBe(true);
  });
});
