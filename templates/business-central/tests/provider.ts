import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { Request, Response } from "miniflare";
import { z } from "zod";

const kind = "microsoft";

const base64url = (value: Uint8Array) =>
  btoa(Array.from(value, (byte) => String.fromCharCode(byte)).join(""))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

const encode = (value: string) => base64url(new TextEncoder().encode(value));

type Answer = { status: number; body: object | null; headers: Record<string, string> };

type State = {
  refreshes: number;
  unavailable: boolean;
  // The scopes a consent grants; tests narrow them to check reauthorization.
  scope: string;
  // The `scope` of each token request, which decides the token's resource.
  requested: (string | null)[];
  // An answer that replaces the next Business Central response.
  answer: Answer | null;
};

export const api = "https://api.businesscentral.dynamics.com";

const companies = `${api}/v2.0/production/api/v2.0/companies`;

const company = "8b4f0a20-0000-4000-8000-000000000001";

const customer = (id: string, displayName: string, version: number) => ({
  "@odata.etag": `W/"JzE5OzEwMDAwMDAwMDAwMDAwMDAwMDA7MDA7Jw==${version}"`,
  id,
  number: id.slice(-5),
  displayName,
  type: "Company",
  balanceDue: 0,
});

// A small PDF document, as Business Central renders a sales invoice.
export const pdf = new TextEncoder().encode("%PDF-1.7\n%âãÏÓ\n1 0 obj\n");

export const provider = () => {
  const codes = new Map<
    string,
    { user: string; challenge: string; redirect: string; nonce: string | null }
  >();

  const access = new Map<string, string>();
  const refresh = new Map<string, string>();

  const calls: {
    method: string;
    url: string;
    body: string | null;
    type: string | null;
    match: string | null;
  }[] = [];

  const state: State = {
    refreshes: 0,
    unavailable: false,
    scope:
      "https://api.businesscentral.dynamics.com/Financials.ReadWrite.All openid profile email offline_access",
    requested: [],
    answer: null,
  };

  // Each customer's current version; a change needs it in If-Match.
  const versions = new Map([["c-10000", 1]]);

  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });

  const jwk = {
    ...keys.publicKey.export({ format: "jwk" }),
    kid: "test-key",
    alg: "RS256",
    use: "sig",
  };

  const tenant = "9188040d-6c67-4c5b-b112-36a304b66dad";

  const tokens = (user: string, nonce: string | null = null) => {
    const accessToken = `synthetic-access-${crypto.randomUUID()}`;
    const refreshToken = `synthetic-refresh-${crypto.randomUUID()}`;
    access.set(accessToken, user);
    refresh.set(refreshToken, user);
    const header = encode(JSON.stringify({ alg: "RS256", kid: jwk.kid }));
    const now = Math.floor(Date.now() / 1000);

    const payload = encode(
      JSON.stringify({
        iss: `https://login.microsoftonline.com/${tenant}/v2.0`,
        aud: `test-${kind}-client`,
        sub: user,
        oid: user,
        tid: tenant,
        iat: now,
        exp: now + 3600,
        name: user,
        email: `${user}@example.test`,
        email_verified: true,
        nonce,
      }),
    );

    const unsigned = `${header}.${payload}`;
    const signature = base64url(sign("RSA-SHA256", unsigned, keys.privateKey));

    return Response.json({
      access_token: accessToken,
      refresh_token: refreshToken,
      id_token: `${unsigned}.${signature}`,
      expires_in: 3600,
      token_type: "Bearer",
      scope: state.scope,
    });
  };

  return {
    state,
    calls,
    company,
    authorize: (location: string, user: string) => {
      const url = new URL(location);
      const redirect = z.url().parse(url.searchParams.get("redirect_uri"));
      const challenge = z.string().min(1).parse(url.searchParams.get("code_challenge"));
      const oauthState = z.string().min(1).parse(url.searchParams.get("state"));

      if (url.searchParams.get("code_challenge_method") !== "S256") throw new Error("Missing PKCE");
      const code = crypto.randomUUID();
      codes.set(code, { user, challenge, redirect, nonce: url.searchParams.get("nonce") });
      const callback = new URL(redirect);
      callback.searchParams.set("code", code);
      callback.searchParams.set("state", oauthState);

      return callback.href;
    },
    fetch: async (request: Request) => {
      const url = new URL(request.url);

      if (url.href === "https://login.microsoftonline.com/common/discovery/v2.0/keys")
        return Response.json({ keys: [jwk] });

      if (url.href === "https://login.microsoftonline.com/common/oauth2/v2.0/token") {
        const form = new URLSearchParams(await request.text());

        if (
          form.get("client_id") !== `test-${kind}-client` ||
          form.get("client_secret") !== `test-${kind}-secret`
        )
          return Response.json({ error: "invalid_client" }, { status: 400 });
        state.requested.push(form.get("scope"));

        if (form.get("grant_type") === "authorization_code") {
          const code = form.get("code") ?? "";
          const saved = codes.get(code);
          codes.delete(code);

          const challenge = createHash("sha256")
            .update(form.get("code_verifier") ?? "")
            .digest("base64url");

          if (
            !saved ||
            saved.challenge !== challenge ||
            saved.redirect !== form.get("redirect_uri")
          )
            return Response.json({ error: "invalid_grant" }, { status: 400 });

          return tokens(saved.user, saved.nonce);
        }

        if (form.get("grant_type") === "refresh_token") {
          state.refreshes++;

          if (state.unavailable)
            return Response.json({ error: "temporarily_unavailable" }, { status: 503 });
          const user = refresh.get(form.get("refresh_token") ?? "");

          if (!user) return Response.json({ error: "invalid_grant" }, { status: 400 });

          return tokens(user);
        }
      }

      const user = access.get((request.headers.get("authorization") ?? "").replace(/^Bearer /, ""));

      if (!user) return new Response(null, { status: 401 });

      calls.push({
        method: request.method,
        url: url.href,
        body: (await request.text()) || null,
        type: request.headers.get("content-type"),
        match: request.headers.get("if-match"),
      });

      if (state.answer) {
        const { status, body, headers } = state.answer;
        state.answer = null;

        return body === null
          ? new Response(null, { status, headers })
          : Response.json(body, { status, headers });
      }

      const path = `${url.origin}${url.pathname}`;
      const customers = `${companies}(${company})/customers`;
      const invoice = `${companies}(${company})/salesInvoices(i-1)`;

      if (path === `${api}/environments/v1.2`)
        return Response.json({
          value: [
            {
              aadTenantId: tenant,
              applicationFamily: "BusinessCentral",
              type: "Production",
              name: "production",
              countryCode: "DE",
            },
          ],
        });

      if (path === companies)
        return Response.json({ value: [{ id: company, name: "CRONUS", displayName: "CRONUS" }] });

      if (path === customers && request.method === "GET")
        return Response.json(
          url.searchParams.has("$skiptoken")
            ? { value: [customer("c-20000", "Trey Research", 1)] }
            : {
                value: [customer(`c-${user}00`, "Adatum", 1)],
                "@odata.nextLink": `${customers}?$filter=balanceDue%20gt%200&$skiptoken=page-2`,
              },
        );

      if (path === customers && request.method === "POST")
        return Response.json(customer("c-30000", "Fabrikam", 1), { status: 201 });

      if (path === `${customers}(c-10000)`) {
        const version = versions.get("c-10000") ?? 0;

        if (request.headers.get("if-match") !== customer("c-10000", "", version)["@odata.etag"])
          return Response.json(
            {
              error: {
                code: "Request_EntityChanged",
                message: "Another user has already changed the record.",
              },
            },
            { status: 412 },
          );

        if (request.method === "DELETE") return new Response(null, { status: 204 });
        versions.set("c-10000", version + 1);

        return Response.json(customer("c-10000", "Adatum Corporation", version + 1));
      }

      if (path === `${invoice}/Microsoft.NAV.post` && request.method === "POST")
        return new Response(null, { status: 204 });

      if (path === `${invoice}/Microsoft.NAV.send` && request.method === "POST")
        return new Response(null, { status: 204 });

      if (path === `${invoice}/pdfDocument/pdfDocumentContent` && request.method === "GET")
        return new Response(pdf, { headers: { "content-type": "application/pdf" } });

      throw new Error(`Unexpected outbound request: ${url.origin}${url.pathname}`);
    },
  };
};
