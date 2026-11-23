import { describe, expect, it } from "vitest";
import { fieldsExpression, type GoogleOperation, googleRequest } from "./runtime/google.ts";
import { type Arguments, type FieldSelection, InvalidRequest } from "./runtime/input.ts";

const get: GoogleOperation = {
  httpMethod: "GET",
  path: "gmail/v1/users/{userId}/messages/{id}",
  pathParameters: { userId: "me", id: null },
  queryParameters: ["format", "metadataHeaders"],
  body: false,
  response: true,
};

const send: GoogleOperation = {
  httpMethod: "POST",
  path: "gmail/v1/users/{userId}/messages/send",
  pathParameters: { userId: "me" },
  queryParameters: [],
  body: true,
  response: true,
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
});
