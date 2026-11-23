import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { download, swaggerPage } from "./openapi.ts";

const scriptUrl =
  "https://developer.garmin.com/component---src-pages-gc-developer-program-personal-swagger-docs-js-7ced9e541531dfdd103f.js";

const page = `<!doctype html><html><head><script src="/component---src-pages-gc-developer-program-personal-swagger-docs-js-7ced9e541531dfdd103f.js" async=""></script></head></html>`;

// A frozen excerpt in the form of Garmin's script: the description is a
// single-quoted string with escaped quotes, backslashes, characters and a
// continued line, followed by more code.
const script = String.raw`!function(){var t={wOaG:function(e){e.exports=JSON.parse('{"openapi":"3.0.1","tags":[{"name":"Women\'s Health"}],"info":{"title":"Say \\"hi\\"","description":"C:\\\\data \u00e9 \x41 \u{1F3C3}\
 done"},"paths":{}}')},x:function(){return'unrelated'}}}();`;

describe("Garmin's Swagger description", () => {
  let responses: Map<string, string>;
  let requested: string[];

  beforeEach(() => {
    responses = new Map([
      [swaggerPage, page],
      [scriptUrl, script],
    ]);
    requested = [];

    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : input.toString();
      requested.push(url);
      const body = responses.get(url);

      return body === undefined ? new Response(null, { status: 404 }) : new Response(body);
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads the description from the page's script and decodes its escapes", async () => {
    expect(JSON.parse(await download())).toEqual({
      openapi: "3.0.1",
      tags: [{ name: "Women's Health" }],
      info: { title: 'Say "hi"', description: "C:\\data é A 🏃 done" },
      paths: {},
    });
    expect(requested).toEqual([swaggerPage, scriptUrl]);
  });

  it("stops when the page, its script or the description is missing", async () => {
    responses.set(swaggerPage, "<!doctype html><html></html>");
    await expect(download()).rejects.toThrow("Garmin's Swagger page no longer names its script");

    responses.set(swaggerPage, page);
    responses.set(scriptUrl, "!function(){return JSON.parse('{}')}();");
    await expect(download()).rejects.toThrow(
      "Garmin's Swagger script no longer holds the description",
    );

    responses.set(scriptUrl, String.raw`e.exports=JSON.parse('{"openapi":"3.0.1","x":"\'`);
    await expect(download()).rejects.toThrow("The string does not end");

    responses.delete(scriptUrl);
    await expect(download()).rejects.toThrow(`${scriptUrl} answered HTTP 404`);
  });
});
