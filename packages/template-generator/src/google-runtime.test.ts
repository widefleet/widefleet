import { describe, expect, it } from "vitest";
import { fieldsExpression, type GoogleOperation, googleRequest } from "./runtime/google.ts";
import { type Arguments, type FieldSelection, InvalidRequest } from "./runtime/input.ts";

const get: GoogleOperation = {
  httpMethod: "GET",
  path: "gmail/v1/users/{userId}/messages/{id}",
  pathParameters: { userId: "me", id: null },
  queryParameters: ["format", "metadataHeaders"],
  requiredParameters: [],
  body: false,
  response: "json",
  altMedia: false,
  upload: null,
};

const send: GoogleOperation = {
  httpMethod: "POST",
  path: "gmail/v1/users/{userId}/messages/send",
  pathParameters: { userId: "me" },
  queryParameters: [],
  requiredParameters: [],
  body: true,
  response: "json",
  altMedia: false,
  upload: null,
};

const base = "https://gmail.googleapis.com/";

describe("Google API requests", () => {
  it("writes nested selections as Google's fields expression", () => {
    expect(
      fieldsExpression({
        id: true,
        payload: { headers: { name: true }, parts: { mimeType: true } },
      }),
    ).toBe("id,payload(headers(name),parts(mimeType))");
  });

  it("fills path parameters and their defaults, repeats list parameters and sends the body", () => {
    const read = googleRequest(
      base,
      "messagesGet",
      get,
      { id: "a/b", metadataHeaders: ["From", "To"] },
      { id: true },
    );

    expect(read.url).toBe(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/a%2Fb?metadataHeaders=From&metadataHeaders=To&fields=id",
    );
    expect(read.init).toEqual({ method: "GET" });

    const written = googleRequest(
      base,
      "messagesSend",
      send,
      { body: { raw: "eA", threadId: undefined } },
      { id: true },
    );

    expect(written.init).toEqual({
      method: "POST",
      body: '{"raw":"eA"}',
      headers: { "content-type": "application/json" },
    });
  });

  it("rejects requests that do not match the method before sending them", () => {
    const invalid = (input: Arguments, select?: FieldSelection) => () =>
      googleRequest(base, "messagesGet", get, input, select);

    expect(invalid({ id: "a", unknown: 1 }, { id: true })).toThrow(
      new InvalidRequest("messagesGet has no argument unknown"),
    );
    expect(invalid({}, { id: true })).toThrow("messagesGet needs id");
    expect(() =>
      googleRequest(
        base,
        "messagesGet",
        { ...get, requiredParameters: ["format"] },
        { id: "a" },
        {
          id: true,
        },
      ),
    ).toThrow("messagesGet needs format");
    // `..` would move the request to the parent path.
    expect(invalid({ id: ".." }, { id: true })).toThrow("messagesGet's id is not an ID");
    expect(invalid({ id: "a" })).toThrow("messagesGet needs a selection of the fields to return");
    expect(invalid({ id: "a" }, { "id)": true })).toThrow("Unknown field id)");
    expect(invalid({ id: "a" }, { payload: {} })).toThrow("Select at least one field of payload");
    expect(invalid({ id: "a", format: { nested: 1 } }, { id: true })).toThrow(
      "messagesGet's format takes a value or a list",
    );
    expect(invalid({ constructor: "x", id: "a" }, { id: true })).toThrow(
      "messagesGet has no argument constructor",
    );
    expect(() => googleRequest(base, "messagesSend", send, {}, { id: true })).toThrow(
      "messagesSend needs a body",
    );
  });

  it("reads content with alt=media and uploads metadata and content in one multipart request", () => {
    const content = googleRequest(
      base,
      "filesGetContent",
      {
        ...get,
        path: "drive/v3/files/{fileId}",
        pathParameters: { fileId: null },
        queryParameters: [],
        response: "content",
        altMedia: true,
      },
      { fileId: "f" },
    );

    expect(content.url).toBe("https://gmail.googleapis.com/drive/v3/files/f?alt=media");

    const upload = {
      ...send,
      path: "drive/v3/files",
      pathParameters: {},
      upload: "/upload/drive/v3/files",
    };

    const created = googleRequest(
      "https://www.googleapis.com/drive/v3/",
      "filesCreateWithContent",
      upload,
      { body: { name: "a.txt" }, content: { mimeType: "text/plain", base64: "AAEC" } },
      { id: true },
    );

    expect(created.url).toBe(
      "https://www.googleapis.com/upload/drive/v3/files?fields=id&uploadType=multipart",
    );

    const boundary = /boundary=(\S+)/.exec(
      new Headers(created.init.headers).get("content-type") ?? "",
    )?.[1];

    expect(created.init.body).toBe(
      [
        `--${boundary}`,
        "Content-Type: application/json; charset=UTF-8",
        "",
        '{"name":"a.txt"}',
        `--${boundary}`,
        "Content-Type: text/plain",
        "Content-Transfer-Encoding: base64",
        "",
        "AAEC",
        `--${boundary}--`,
        "",
      ].join("\r\n"),
    );

    // Content needs text or base64, and a media type without line breaks.
    for (const content of [
      { mimeType: "text/plain" },
      { mimeType: "text/plain\r\nX: y", text: "a" },
      { mimeType: "text/plain\r\n\r\n; charset=utf-8", text: "a" },
      { mimeType: "text/plain", base64: "not base64!" },
    ])
      expect(() =>
        googleRequest(base, "filesCreateWithContent", upload, { content }, { id: true }),
      ).toThrow(InvalidRequest);
  });
});
