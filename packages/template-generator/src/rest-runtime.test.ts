import { describe, expect, it } from "vitest";
import { InvalidRequest } from "./runtime/input.ts";
import { binaryContent, type RestOperation, restRequest } from "./runtime/rest.ts";

const base = "https://graph.example.test/v1.0/";

const list: RestOperation = {
  httpMethod: "GET",
  path: "/drives/{drive-id}/search(q='{q}')",
  pathParameters: { "drive-id": "driveId", q: "q" },
  queryParameters: { $top: ["$top", true], $select: ["$select", false], tag: ["tag", true] },
  body: null,
  response: "json",
  pageable: true,
};

const upload: RestOperation = {
  httpMethod: "PUT",
  path: "/items/{item-id}/content",
  pathParameters: { "item-id": "itemId" },
  queryParameters: {},
  body: "text",
  response: "json",
  pageable: false,
};

describe("REST requests", () => {
  it("fills the path, writes query lists and follows pages on the API's origin", () => {
    expect(
      restRequest(base, "search", list, {
        driveId: "a/b",
        q: "report",
        $top: 5,
        $select: ["id", "name"],
        tag: ["x", "y"],
      }),
    ).toEqual({
      url: "https://graph.example.test/v1.0/drives/a%2Fb/search(q='report')?%24top=5&%24select=id%2Cname&tag=x&tag=y",
      init: { method: "GET" },
    });

    expect(restRequest(base, "search", list, { driveId: "d", q: "it's" }).url).toBe(
      "https://graph.example.test/v1.0/drives/d/search(q='it''s')",
    );

    const next = `${base}drives/d/search(q='report')?$skiptoken=2`;

    expect(restRequest(base, "search", list, { nextLink: next }).url).toBe(next);
    expect(() => restRequest(base, "search", list, { nextLink: "https://other.test/" })).toThrow(
      InvalidRequest,
    );
  });

  it("sends text bodies with their media type and rejects unknown arguments", () => {
    expect(
      restRequest(base, "upload", upload, {
        itemId: "1",
        body: "hello",
        contentType: "text/plain",
      }),
    ).toEqual({
      url: "https://graph.example.test/v1.0/items/1/content",
      init: { method: "PUT", body: "hello", headers: { "content-type": "text/plain" } },
    });
    expect(restRequest(base, "upload", upload, { itemId: "1", body: "x" }).init.headers).toEqual({
      "content-type": "application/octet-stream",
    });
    expect(() => restRequest(base, "upload", upload, { itemId: "1", body: 3 })).toThrow(
      InvalidRequest,
    );
    expect(() => restRequest(base, "search", list, { driveId: "d", q: "x", top: 1 })).toThrow(
      new InvalidRequest("search has no argument top"),
    );
    expect(() => restRequest(base, "search", list, { q: "x" })).toThrow("search needs driveId");
  });

  it("returns download addresses and small content", async () => {
    expect(
      await binaryContent(
        new Response(null, { status: 302, headers: { location: "https://download.test/f" } }),
      ),
    ).toEqual({ downloadUrl: "https://download.test/f" });
    expect(
      await binaryContent(new Response("text", { headers: { "content-type": "text/plain" } })),
    ).toEqual({ contentType: "text/plain", data: new TextEncoder().encode("text") });
    // Larger content is not read.
    expect(await binaryContent(new Response(new Uint8Array(9 * 1024 * 1024)))).toBeNull();
    expect(
      restRequest(base, "upload", upload, { itemId: "1", body: "x", contentType: undefined }).init,
    ).toMatchObject({ headers: { "content-type": "application/octet-stream" } });
  });
});
