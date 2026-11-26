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
  // An answer that replaces the next Dataverse or discovery response.
  answer: Answer | null;
  // Runs while a refresh is answered, as another request would meanwhile.
  duringRefresh: (() => Promise<void>) | null;
};

const discovery = "https://globaldisco.crm.dynamics.com";

/** The environments discovery lists, and the Web API of the first. */
export const environments = {
  sales: "https://sales.api.crm4.dynamics.com",
  test: "https://test.api.crm4.dynamics.com",
};

const api = `${environments.sales}/api/data/v9.2`;

export const provider = () => {
  const codes = new Map<
    string,
    {
      user: string;
      challenge: string;
      redirect: string;
      nonce: string | null;
    }
  >();

  // Each access token belongs to one user and one resource.
  const access = new Map<string, { user: string; resource: string }>();
  const refresh = new Map<string, string>();
  const calls: { method: string; url: string; body: string | null; type: string | null }[] = [];

  const state: State = {
    refreshes: 0,
    unavailable: false,
    scope: `openid profile email offline_access ${discovery}/user_impersonation`,
    answer: null,
    duringRefresh: null,
  };

  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });

  const jwk = {
    ...keys.publicKey.export({ format: "jwk" }),
    kid: "test-key",
    alg: "RS256",
    use: "sig",
  };

  const tenant = "9188040d-6c67-4c5b-b112-36a304b66dad";

  const tokens = (user: string, resource: string, nonce: string | null = null) => {
    const accessToken = `synthetic-access-${crypto.randomUUID()}`;
    const refreshToken = `synthetic-refresh-${crypto.randomUUID()}`;
    access.set(accessToken, { user, resource });
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

      if (url.href === "https://login.microsoftonline.com/organizations/discovery/v2.0/keys")
        return Response.json({ keys: [jwk] });

      if (url.href === "https://login.microsoftonline.com/organizations/oauth2/v2.0/token") {
        const form = request.headers.get("content-type")?.includes("application/json")
          ? new URLSearchParams(z.record(z.string(), z.string()).parse(await request.json()))
          : new URLSearchParams(await request.text());

        if (
          form.get("client_id") !== `test-${kind}-client` ||
          form.get("client_secret") !== `test-${kind}-secret`
        )
          return Response.json({ error: "invalid_client" }, { status: 400 });

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

          return tokens(saved.user, discovery, saved.nonce);
        }

        if (form.get("grant_type") === "refresh_token") {
          state.refreshes++;

          if (state.unavailable)
            return Response.json({ error: "temporarily_unavailable" }, { status: 503 });
          const user = refresh.get(form.get("refresh_token") ?? "");

          if (!user) return Response.json({ error: "invalid_grant" }, { status: 400 });
          await state.duringRefresh?.();

          // A refresh for another resource names it in its scope.
          const resource = /(https:\/\/[^/\s]+)\/user_impersonation/.exec(
            form.get("scope") ?? "",
          )?.[1];

          return tokens(user, resource ?? discovery);
        }
      }

      const token = access.get(
        (request.headers.get("authorization") ?? "").replace(/^Bearer /, ""),
      );

      // Microsoft binds each token to one resource.
      if (!token || token.resource !== url.origin) return new Response(null, { status: 401 });

      calls.push({
        method: request.method,
        url: url.href,
        body: (await request.text()) || null,
        type: request.headers.get("content-type"),
      });

      if (state.answer) {
        const { status, body, headers } = state.answer;
        state.answer = null;

        return body === null
          ? new Response(null, { status, headers })
          : Response.json(body, { status, headers });
      }

      if (url.origin === discovery && url.pathname === "/api/discovery/v2.0/Instances")
        return Response.json({
          value: [
            { FriendlyName: "Sales", ApiUrl: environments.sales, State: 0, IsUserSysAdmin: true },
            { FriendlyName: "Test", ApiUrl: environments.test, State: 0, IsUserSysAdmin: false },
            { FriendlyName: "Disabled", ApiUrl: "https://off.api.crm4.dynamics.com", State: 1 },
          ],
        });

      // Every environment answers alike; the tests check which one was called.
      const path = `${api}${url.pathname.replace(/^\/api\/data\/v9\.2/, "")}`;

      // The service document lists entity sets; unbound actions are not among them.
      if (path === `${api}/` && request.method === "GET")
        return Response.json({
          value: [
            { name: "accounts", kind: "EntitySet", url: "accounts" },
            { name: "EntityDefinitions", kind: "EntitySet", url: "EntityDefinitions" },
          ],
        });

      if (
        decodeURIComponent(path) ===
          `${api}/EntityDefinitions(LogicalName='new_scrap')/Attributes` &&
        request.method === "POST"
      )
        return new Response(null, { status: 204 });

      if (
        decodeURIComponent(path).startsWith(
          `${api}/EntityDefinitions(LogicalName='account')/Attributes(LogicalName='industrycode')`,
        ) &&
        request.method === "GET"
      )
        return Response.json({ LogicalName: "industrycode" });

      if (
        decodeURIComponent(path).startsWith(`${api}/msdyn_GetSummary(`) &&
        request.method === "GET"
      )
        return Response.json({ Summary: "Short" });

      if (path === `${api}/accounts` && request.method === "GET")
        return Response.json(
          url.searchParams.has("$skiptoken")
            ? { value: [{ accountid: "account-2", name: "Second" }] }
            : {
                value: [{ accountid: `account-${token.user}`, name: "Contoso" }],
                "@odata.nextLink": `${api}/accounts?$skiptoken=page-2`,
              },
        );

      if (path === `${api}/accounts` && request.method === "POST")
        return Response.json(
          { accountid: "account-new", name: "New" },
          { status: 201, headers: { "OData-EntityId": `${api}/accounts(account-new)` } },
        );

      // A batch with a change set and a read.
      if (path === `${api}/$batch` && request.method === "POST")
        return new Response(
          [
            "--batchresponse_1",
            "Content-Type: multipart/mixed; boundary=changesetresponse_1",
            "",
            "--changesetresponse_1",
            "Content-Type: application/http",
            "Content-Transfer-Encoding: binary",
            "Content-ID: 1",
            "",
            "HTTP/1.1 204 No Content",
            `OData-EntityId: ${api}/accounts(a-1)`,
            "",
            "",
            "--changesetresponse_1--",
            "--batchresponse_1",
            "Content-Type: application/http",
            "Content-Transfer-Encoding: binary",
            "",
            "HTTP/1.1 200 OK",
            "Content-Type: application/json; odata.metadata=minimal",
            "",
            '{"value":[]}',
            "--batchresponse_1--",
            "",
          ].join("\r\n"),
          { headers: { "content-type": "multipart/mixed; boundary=batchresponse_1" } },
        );

      if (
        path === `${api}/accounts(00000000-0000-0000-0000-000000000001)` &&
        request.method === "GET"
      )
        return new Response(null, { status: 304 });

      if (
        path === `${api}/accounts(00000000-0000-0000-0000-000000000001)/new_report` &&
        request.method === "PATCH"
      )
        return new Response(null, { status: 204 });

      if (url.pathname === "/api/search/v2.0/query" && request.method === "POST")
        return Response.json({ response: "{}" });

      if (
        path === `${api}/accounts(00000000-0000-0000-0000-000000000001)` &&
        request.method === "DELETE"
      )
        return new Response(null, { status: 204 });

      if (path === `${api}/WhoAmI()` && request.method === "GET")
        return Response.json({
          UserId: `user-${token.user}`,
          BusinessUnitId: "unit",
          OrganizationId: "org",
        });

      if (path.startsWith(`${api}/RetrieveTotalRecordCount(`) && request.method === "GET")
        return Response.json({
          EntityRecordCountCollection: {
            Count: 1,
            IsReadOnly: true,
            Keys: ["account"],
            Values: [7],
          },
        });

      if (path === `${api}/$metadata` && request.method === "GET")
        return new Response("<edmx:Edmx/>", { headers: { "content-type": "application/xml" } });

      throw new Error(`Unexpected outbound request: ${url.origin}${url.pathname}`);
    },
  };
};
