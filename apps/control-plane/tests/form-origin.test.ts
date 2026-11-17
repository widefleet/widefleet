import { describe, expect, it } from "vitest";
import { checkFormOrigin } from "../src/lib/server/form-origin.ts";

describe("Form origin checks with OAuth back-channel exchange", () => {
  it.each(["POST", "PUT", "PATCH", "DELETE"])(
    "rejects cross-origin %s forms and missing content type",
    (method) => {
      for (const type of [
        "",
        "application/x-www-form-urlencoded",
        "multipart/form-data; boundary=x",
        "text/plain",
      ]) {
        for (const origin of ["", "null", "https://foreign.example.test"]) {
          const headers = new Headers();

          if (type) headers.set("content-type", type);

          if (origin) headers.set("origin", origin);
          expect(
            checkFormOrigin(
              new Request("https://platform.example.test/api/auth/sign-out", { method, headers }),
            )?.status,
          ).toBe(403);
        }
      }
    },
  );

  it("exempts only cookie-free form POSTs to the exact OAuth token endpoint", () => {
    const headers = { "content-type": "application/x-www-form-urlencoded" };
    const url = "https://platform.example.test/api/auth/oauth2/token";
    expect(checkFormOrigin(new Request(url, { method: "POST", headers }))).toBeNull();
    expect(
      checkFormOrigin(
        new Request(url, { method: "POST", headers: { ...headers, cookie: "session=browser" } }),
      )?.status,
    ).toBe(403);
    expect(checkFormOrigin(new Request(url + "/", { method: "POST", headers }))?.status).toBe(403);
    expect(checkFormOrigin(new Request(url, { method: "DELETE", headers }))?.status).toBe(403);
    expect(
      checkFormOrigin(
        new Request(url, { method: "POST", headers: { "content-type": "text/plain" } }),
      )?.status,
    ).toBe(403);
  });

  it("accepts same-origin forms and leaves JSON API authentication to the endpoint", () => {
    const url = "https://platform.example.test/api/v1/apps";
    expect(
      checkFormOrigin(
        new Request(url, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            origin: new URL(url).origin,
            cookie: "session=browser",
          },
        }),
      ),
    ).toBeNull();
    expect(
      checkFormOrigin(
        new Request(url, { method: "POST", headers: { "content-type": "application/json" } }),
      ),
    ).toBeNull();
    expect(checkFormOrigin(new Request(url))).toBeNull();
  });
});
