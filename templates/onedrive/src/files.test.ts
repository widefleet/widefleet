import { describe, expect, it } from "vitest";
import { continuation, folderPath, readPage, filePage, searchPath } from "./files.ts";

describe("OneDrive requests", () => {
  it("allows a Graph continuation only for the requested collection", () => {
    const path = "/v1.0/me/drive/root/children";
    expect(continuation(`https://graph.microsoft.com${path}?$skiptoken=a%2Bb`, path)).toBe(
      `${path}?$skiptoken=a%2Bb`,
    );
    expect(
      continuation(
        "https://graph.microsoft.com/v1.0/drives/drive/items/root/children?$skiptoken=next",
        path,
      ),
    ).toContain("/drives/drive/items/root/children");

    for (const url of [
      `https://untrusted.example${path}?token=1`,
      `https://graph.microsoft.com@untrusted.example${path}`,
      `https://user:password@graph.microsoft.com${path}`,
      "https://graph.microsoft.com/v1.0/users/another-user/drive/root/children",
      `http://graph.microsoft.com${path}`,
    ])
      expect(() => continuation(url, path)).toThrow();
  });

  it("escapes apostrophes and URL syntax in search expressions", () => {
    const path = searchPath({ query: "Alice's #notes&x=1" });
    expect(decodeURIComponent(path)).toBe(
      "/v1.0/me/drive/root/search(q='Alice''s #notes&x=1')?$top=100",
    );
    const url = new URL(path, "https://graph.microsoft.com");
    expect(url.hash).toBe("");
    expect(url.searchParams.has("x")).toBe(false);
    expect(folderPath({})).toBe("/v1.0/me/drive/root/children?$top=100");
  });

  it("does not return provider-supplied preauthenticated download URLs in file listings", () => {
    const result = readPage(
      filePage.parse({
        value: [
          {
            id: "file",
            name: "report.pdf",
            size: 10,
            "@microsoft.graph.downloadUrl": "https://download.example/?secret=1",
          },
        ],
      }),
    );

    expect(result.files).toEqual([{ id: "file", name: "report.pdf", size: 10 }]);
  });
});
