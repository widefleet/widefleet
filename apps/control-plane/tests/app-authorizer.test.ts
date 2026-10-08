import { describe, expect, it } from "vitest";
import { authorizeAppRequest } from "../tools/app-authorizer.ts";

const issuer = "https://login.example.test/tenant";

const policy = {
  revision: 3,
  provider: issuer,
  users: ["owner"],
  groups: ["engineering"],
  allAuthenticated: false,
};

const request = (overrides = {}, headers = {}) =>
  new Request(
    `http://authorizer/authorize?${new URLSearchParams({ policy: Buffer.from(JSON.stringify({ ...policy, ...overrides })).toString("base64url") })}`,
    { headers },
  );

const session =
  (subject: string, groups = "") =>
  async () =>
    new Response(null, {
      status: 202,
      headers: { "x-auth-request-user": subject, "x-auth-request-groups": groups },
    });

describe("Local app authorization", () => {
  it("accepts an individual or any allowed group without a control-plane connection", async () => {
    expect((await authorizeAppRequest(request(), issuer, undefined, session("owner"))).status).toBe(
      202,
    );
    expect(
      (
        await authorizeAppRequest(
          request(),
          issuer,
          undefined,
          session("developer", "other,engineering"),
        )
      ).status,
    ).toBe(202);
    expect(
      (await authorizeAppRequest(request(), issuer, undefined, session("outsider"))).status,
    ).toBe(403);
  });
  it("denies empty rules and requires explicit all-authenticated access", async () => {
    expect(
      (
        await authorizeAppRequest(
          request({ users: [], groups: [] }),
          issuer,
          undefined,
          session("outsider"),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await authorizeAppRequest(
          request({ users: [], groups: [], allAuthenticated: true }),
          issuer,
          undefined,
          session("outsider"),
        )
      ).status,
    ).toBe(202);
    expect(
      (
        await authorizeAppRequest(
          request(),
          "https://other.example.test",
          undefined,
          session("owner"),
        )
      ).status,
    ).toBe(403);
  });
  it("ignores spoofed identity and preserves SSO redirects", async () => {
    expect(
      (
        await authorizeAppRequest(
          request({}, { "x-auth-request-user": "owner", "x-auth-request-groups": "engineering" }),
          issuer,
          undefined,
          session("outsider"),
        )
      ).status,
    ).toBe(403);

    const result = await authorizeAppRequest(
      request(),
      issuer,
      undefined,
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://login.example.test/start", "set-cookie": "csrf=fixture" },
        }),
    );

    expect(result.status).toBe(302);
    expect(result.headers.get("location")).toBe("https://login.example.test/start");
  });
  it("rejects missing or malformed policy instead of opening access", async () => {
    for (const url of [
      "http://authorizer/authorize",
      "http://authorizer/authorize?policy=invalid",
      "http://authorizer/?policy=e30",
    ])
      expect(
        (await authorizeAppRequest(new Request(url), issuer, undefined, session("owner"))).status,
      ).toBe(403);
  });
});
