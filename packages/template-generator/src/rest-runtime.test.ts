import { describe, expect, it } from "vitest";
import { z } from "zod";
import { InvalidRequest } from "./runtime/input.ts";
import { binaryContent } from "./runtime/content.ts";
import { type RestOperation, restRequest } from "./runtime/rest.ts";

const base = "https://graph.example.test/v1.0/";

const list: RestOperation = {
  httpMethod: "GET",
  path: "/drives/{drive-id}/search(q='{q}')",
  pathParameters: { "drive-id": "driveId", q: "q" },
  queryParameters: {
    $top: ["$top", null, false],
    $select: ["$select", ",", false],
    tag: ["tag", null, false],
    ids: ["ids", "|", false],
  },
  headerParameters: { sessionId: "session-id" },
  body: null,
  bodyRequired: false,
  response: "json",
  pageable: true,
};

const upload: RestOperation = {
  httpMethod: "PUT",
  path: "/items/{item-id}/content",
  pathParameters: { "item-id": "itemId" },
  queryParameters: {},
  headerParameters: {},
  body: "text",
  bodyRequired: true,
  response: "json",
  pageable: false,
};

const form: RestOperation = {
  httpMethod: "POST",
  path: "/activities",
  pathParameters: {},
  queryParameters: {},
  headerParameters: {},
  body: "form",
  bodyRequired: true,
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
        ids: ["1", "2"],
      }),
    ).toEqual({
      url: "https://graph.example.test/v1.0/drives/a%2Fb/search(q='report')?%24top=5&%24select=id%2Cname&tag=x&tag=y&ids=1%7C2",
      init: { method: "GET" },
    });

    // Tab-separated lists join with a tab.
    expect(
      restRequest(
        base,
        "search",
        { ...list, queryParameters: { cells: ["cells", "\t", false] } },
        { driveId: "d", q: "x", cells: ["a", "b"] },
      ).url,
    ).toBe("https://graph.example.test/v1.0/drives/d/search(q='x')?cells=a%09b");

    expect(restRequest(base, "search", list, { driveId: "d", q: "it's" }).url).toBe(
      "https://graph.example.test/v1.0/drives/d/search(q='it''s')",
    );

    const next = `${base}drives/d/search(q='report')?$skiptoken=2`;

    expect(restRequest(base, "search", list, { nextLink: next }).url).toBe(next);
    expect(() => restRequest(base, "search", list, { nextLink: "https://other.test/" })).toThrow(
      InvalidRequest,
    );
    // Graph's links may name the function's argument `query`.
    const renamed = `${base}drives/d/search(query='report')?$skiptoken=2`;

    expect(restRequest(base, "search", list, { nextLink: renamed }).url).toBe(renamed);
    // A link must lead to a page of the same operation.
    expect(() => restRequest(base, "search", list, { nextLink: `${base}me` })).toThrow(
      InvalidRequest,
    );
    expect(() =>
      restRequest(base, "search", list, { nextLink: `${base}drives/d/other(q='report')` }),
    ).toThrow(InvalidRequest);

    const delta = { ...list, path: "/drives/{drive-id}/items/{item-id}/delta()" };

    for (const link of [
      `${base}drives/d/items/root/delta()?$skiptoken=1`,
      `${base}drives/d/items/root/delta(token='abc')`,
      `${base}drives/d/items/root/delta(token=%27abc%27)`,
    ])
      expect(restRequest(base, "delta", delta, { nextLink: link }).url).toBe(link);
    expect(() =>
      restRequest(base, "delta", delta, { nextLink: `${base}drives/d/items/root/children` }),
    ).toThrow(InvalidRequest);
  });

  it("sends header inputs as headers, on later pages too", () => {
    expect(
      restRequest(base, "search", list, { driveId: "d", q: "x", sessionId: "s-1" }).init,
    ).toEqual({ method: "GET", headers: { "session-id": "s-1" } });

    const next = `${base}drives/d/search(q='x')?$skiptoken=2`;

    expect(restRequest(base, "search", list, { nextLink: next, sessionId: "s-1" })).toEqual({
      url: next,
      init: { method: "GET", headers: { "session-id": "s-1" } },
    });
    expect(() => restRequest(base, "search", list, { driveId: "d", q: "x", sessionId: 1 })).toThrow(
      "search's sessionId takes text",
    );
  });

  it("needs the header inputs an operation requires", () => {
    const update: RestOperation = {
      ...upload,
      httpMethod: "PATCH",
      body: "json",
      headerParameters: { etag: "If-Match" },
      requiredHeaders: ["etag"],
    };

    expect(() => restRequest(base, "update", update, { itemId: "1", body: {} })).toThrow(
      "update needs etag",
    );
    expect(
      restRequest(base, "update", update, { itemId: "1", etag: 'W/"1"', body: {} }).init.headers,
    ).toEqual({ "content-type": "application/json", "If-Match": 'W/"1"' });
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
    // `..` would move a request to the parent path.
    expect(() => restRequest(base, "search", list, { driveId: "..", q: "x" })).toThrow(
      "search's driveId is not an ID",
    );
    expect(() => restRequest(base, "upload", upload, { itemId: "1" })).toThrow(
      "upload needs a body",
    );
    expect(() =>
      restRequest(
        base,
        "search",
        { ...list, queryParameters: { view: ["view", null, true] } },
        { driveId: "d", q: "x" },
      ),
    ).toThrow("search needs view");
  });

  it("sends form fields as a form, and files in a multipart form", async () => {
    const created = restRequest(base, "create", form, {
      body: { name: "Run", elapsed_time: 60, trainer: false, tags: ["a", "b"], gone: undefined },
    });

    expect(z.instanceof(URLSearchParams).parse(created.init.body).toString()).toBe(
      "name=Run&elapsed_time=60&trainer=false&tags=a&tags=b",
    );

    // Lists the operation joins become one value, with their separator.
    const joined = restRequest(
      base,
      "create",
      { ...form, formLists: { tags: ",", ids: "\t" } },
      { body: { tags: ["a", "b"], ids: [1, 2], kinds: ["x", "y"] } },
    );

    expect(z.instanceof(URLSearchParams).parse(joined.init.body).toString()).toBe(
      "tags=a%2Cb&ids=1%092&kinds=x&kinds=y",
    );
    expect(() =>
      restRequest(
        base,
        "upload",
        { ...form, body: "multipart", formLists: { files: "," } },
        { body: { files: [{ mimeType: "text/plain", text: "x" }] } },
      ),
    ).toThrow(new InvalidRequest("upload's files joins values, not files"));
    // Files and nested objects are no form fields.
    expect(() =>
      restRequest(base, "create", form, { body: { file: { mimeType: "text/plain", text: "x" } } }),
    ).toThrow(new InvalidRequest("create takes its body as fields of values and lists"));
    expect(() => restRequest(base, "create", form, { body: "name=Run" })).toThrow(InvalidRequest);

    const multipart = { ...form, body: "multipart" } as const;

    const uploaded = restRequest(base, "upload", multipart, {
      body: {
        file: { mimeType: "application/gpx+xml", text: "<gpx/>" },
        bytes: { mimeType: "application/octet-stream", base64: btoa("\x00\xff") },
        data_type: "gpx",
      },
    });

    const sent = z.instanceof(FormData).parse(uploaded.init.body);
    // Fetch writes the media type with the form's boundary.
    expect(uploaded.init.headers).toBeUndefined();
    expect(sent.get("data_type")).toBe("gpx");
    const file = z.instanceof(Blob).parse(sent.get("file"));
    expect([file.type, await file.text()]).toEqual(["application/gpx+xml", "<gpx/>"]);
    const bytes = z.instanceof(Blob).parse(sent.get("bytes"));
    expect([...new Uint8Array(await bytes.arrayBuffer())]).toEqual([0x00, 0xff]);

    // Objects, and each object of a list, are JSON parts, as OpenAPI encodes them by default.
    const described = z.instanceof(FormData).parse(
      restRequest(base, "upload", multipart, {
        body: { metadata: { title: "Ride", laps: [1, 2] }, notes: [{ text: "a" }, { text: "b" }] },
      }).init.body,
    );

    const metadata = z.instanceof(Blob).parse(described.get("metadata"));
    expect([metadata.type, await metadata.text()]).toEqual([
      "application/json",
      '{"title":"Ride","laps":[1,2]}',
    ]);
    expect(
      await Promise.all(
        described.getAll("notes").map((part) => z.instanceof(Blob).parse(part).text()),
      ),
    ).toEqual(['{"text":"a"}', '{"text":"b"}']);
    expect(() => restRequest(base, "upload", multipart, { body: "file" })).toThrow(
      new InvalidRequest("upload takes its body as fields of values, lists, files and objects"),
    );
  });

  it("returns download addresses and small content", async () => {
    expect(
      await binaryContent(
        new Response(null, { status: 302, headers: { location: "https://download.test/f" } }),
      ),
    ).toEqual({ downloadUrl: "https://download.test/f" });

    const content = (body: BodyInit, contentType: string) =>
      binaryContent(new Response(body, { headers: { "content-type": contentType } }));

    // Text media types arrive as text, in their charset; other content as base64.
    expect(await content("text", "text/plain")).toEqual({
      contentType: "text/plain",
      text: "text",
    });
    expect(await content("{}", "application/ld+json")).toEqual({
      contentType: "application/ld+json",
      text: "{}",
    });
    expect(
      await content(new Uint8Array([0x4b, 0xe4, 0x73, 0x65]), "text/csv; charset=windows-1252"),
    ).toEqual({ contentType: "text/csv; charset=windows-1252", text: "Käse" });
    expect(await content("text", "image/png")).toEqual({
      contentType: "image/png",
      base64: btoa("text"),
    });
    // Bytes that are not text in the named charset, or an unknown charset, stay bytes.
    expect(await content(new Uint8Array([0xff, 0xfe, 0x00]), "text/plain")).toEqual({
      contentType: "text/plain",
      base64: btoa("\xff\xfe\x00"),
    });
    expect(await content("text", "text/plain; charset=unknown-charset")).toEqual({
      contentType: "text/plain; charset=unknown-charset",
      base64: btoa("text"),
    });
    // Content larger than one chunk of the encoding stays whole, and results are JSON.
    const bytes = Uint8Array.from({ length: 100_000 }, (_, index) => index % 256);
    const large = await binaryContent(new Response(bytes));

    expect(z.json().parse(large)).toEqual(large);
    expect(
      large && "base64" in large && Uint8Array.from(atob(large.base64), (c) => c.charCodeAt(0)),
    ).toEqual(bytes);
    // Larger content is not read.
    expect(await binaryContent(new Response(new Uint8Array(9 * 1024 * 1024)))).toBeNull();
    expect(
      restRequest(base, "upload", upload, { itemId: "1", body: "x", contentType: undefined }).init,
    ).toMatchObject({ headers: { "content-type": "application/octet-stream" } });
  });
});
