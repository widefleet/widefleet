import {
  AuthorizationError,
  authorizationErrorRedirect,
  type AuthRequest,
} from "@cloudflare/workers-oauth-provider";
import { companyOAuth, companySession, companyTokens } from "@platform/auth-proxy/company-oauth";
import { mcpOrganizationPrefix, mcpOrganizationKey } from "@platform/auth-proxy/mcp-login";
import { readAuthConfiguration } from "@platform/auth-proxy/worker";
import { socialIdentity, socialOAuth } from "@platform/auth-proxy/social-oauth";
import { googleGroupsScope, organizationIdentifier } from "@platform/contracts";
import { base64url } from "jose";
import { z } from "zod";
import {
  mcpAuthorizationServer,
  mcpGrant,
  readMcpCompanyConfiguration,
  readMcpConfiguration,
  readMcpLogin,
  readMcpOrganization,
  findMcpOrganization,
} from "./mcp-oauth.ts";
import { mcpPage } from "#mcp-ui";
import type { ParentEnvironment } from "./types.ts";

const random = () => base64url.encode(crypto.getRandomValues(new Uint8Array(32)));

const socialProvider = z.enum(["google", "microsoft"]);

const upstream = z.discriminatedUnion("stage", [
  z.object({
    stage: z.literal("social"),
    provider: socialProvider,
    verifier: z.string(),
    nonce: z.string(),
  }),
  z.object({ stage: z.literal("widefleet") }),
  z.object({
    stage: z.literal("select"),
    identity: socialIdentity,
    tokens: companyTokens,
    nonce: z.string(),
  }),
  z.object({
    stage: z.literal("company"),
    organizationId: organizationIdentifier,
    provider: socialProvider.optional(),
    verifier: z.string(),
    nonce: z.string(),
    expected: socialIdentity.optional(),
  }),
]);

class SignInFailure extends Error {}

const appSessions = async (request: Request, environment: ParentEnvironment) => {
  const ids = new Set<string>();

  for (const cookie of (request.headers.get("cookie") ?? "").split(";")) {
    const match = /^__Secure-platform_sso_([A-Za-z0-9_-]+)\.session_data(?:\.\d+)?=/.exec(
      cookie.trim(),
    );

    if (match?.[1]) ids.add(match[1]);
  }

  // Cookies are only hints until verified. Bound this optional lookup even if
  // a caller supplies many fabricated cookie names.
  if (ids.size > 8) return [];

  const sessions = await Promise.all(
    [...ids].map(async (id) => {
      try {
        const configuration = await readMcpOrganization(environment, id);
        const identity = await companySession(configuration, request.headers);

        return identity ? { configuration, identity } : null;
      } catch {
        return null;
      }
    }),
  );

  return sessions.filter((session) => session !== null);
};

const redirect = (target: string, headers = new Headers()) => {
  headers.set("location", target);
  headers.set("cache-control", "no-store");
  headers.set("referrer-policy", "no-referrer");

  return new Response(null, { status: 303, headers });
};

const form = async (request: Request) => {
  if (
    request.headers.get("origin") !== new URL(request.url).origin ||
    request.headers.get("content-type")?.split(";")[0] !== "application/x-www-form-urlencoded"
  )
    throw new SignInFailure("Restart the connection from your app.");
  const body = await request.text();

  if (body.length > 8192) throw new SignInFailure("Invalid sign-in request.");
  const parameters = new URLSearchParams(body);

  if ([...parameters.keys()].some((key) => parameters.getAll(key).length !== 1))
    throw new SignInFailure("Invalid sign-in request.");

  return parameters;
};

const callbackRequest = (request: Request, state: string) => {
  const url = new URL(request.url);
  url.search = new URLSearchParams({ state }).toString();

  return new Request(url, { headers: request.headers });
};

const matchingOrganizations = async (
  environment: ParentEnvironment,
  identity: z.infer<typeof socialIdentity>,
) => {
  const prefix = mcpOrganizationPrefix(identity.provider, identity.tenant);
  const organizations: Awaited<ReturnType<typeof readMcpOrganization>>[] = [];
  let cursor: string | undefined;

  do {
    const options: KVNamespaceListOptions = { prefix };

    if (cursor) options.cursor = cursor;
    const page = await environment.AUTH_CONFIG.list(options);

    for (const key of page.keys) {
      const organizationId = organizationIdentifier.parse(key.name.slice(prefix.length));
      const current = await findMcpOrganization(environment, organizationId);

      // KV indexes can lag a changed company configuration. Authorize against the
      // current configuration, never against an index entry by itself.
      if (current && mcpOrganizationKey(current) === key.name) organizations.push(current);
    }

    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  return organizations;
};

const complete = async (
  environment: ParentEnvironment,
  request: AuthRequest,
  grant: z.infer<typeof mcpGrant>,
  headers: Headers,
) => {
  const { oauth } = mcpAuthorizationServer(environment);

  // Scope the library's grant owner to the company, including for providers that
  // issue the same subject in more than one customer organization.
  const userId = base64url.encode(
    new TextEncoder().encode(
      JSON.stringify([grant.organizationId, grant.credential.authorization.identity.id]),
    ),
  );

  const result = await oauth.completeAuthorization({
    request,
    userId,
    scope: ["mcp:services"],
    metadata: {},
    props: grant,
  });

  return redirect(result.redirectTo, headers);
};

const beginCompany = async (
  environment: ParentEnvironment,
  request: AuthRequest,
  organizationId: string,
  headers: Headers,
  provider?: "google" | "microsoft",
  expected?: z.infer<typeof socialIdentity>,
) => {
  const configuration = await readMcpCompanyConfiguration(environment, organizationId, provider);
  const company = await companyOAuth(configuration);
  const verifier = random();
  const nonce = random();
  const { oauth } = mcpAuthorizationServer(environment);

  const transaction = await oauth.beginUpstream(request, {
    headers,
    data: { stage: "company", organizationId, provider, expected, verifier, nonce },
  });

  const state = provider ? transaction.state : `mcp.${transaction.state}`;
  const target = await company.authorize(state, verifier, nonce);

  return redirect(target.href, transaction.headers);
};

const acceptSocial = async (
  environment: ParentEnvironment,
  original: AuthRequest,
  selection: Extract<z.infer<typeof upstream>, { stage: "select" }>,
  organizationId: string,
  headers: Headers,
) => {
  const organizations = await matchingOrganizations(environment, selection.identity);

  if (!organizations.some((organization) => organization.organizationId === organizationId))
    throw new SignInFailure("Your account cannot sign in to this organization.");

  const configuration = await readMcpCompanyConfiguration(
    environment,
    organizationId,
    selection.identity.provider,
  );

  if (
    configuration.provider.type === "google" &&
    configuration.scopes?.includes(googleGroupsScope) &&
    !selection.tokens.scopes?.includes(googleGroupsScope)
  )
    return beginCompany(
      environment,
      original,
      organizationId,
      headers,
      "google",
      selection.identity,
    );
  const company = await companyOAuth(configuration);
  const credential = await company.identify(selection.tokens, selection.nonce);

  return complete(
    environment,
    original,
    { organizationId, provider: selection.identity.provider, credential },
    headers,
  );
};

const companyCallback = async (request: Request, environment: ParentEnvironment) => {
  const url = new URL(request.url);
  const match = /^\/oauth2\/([A-Za-z0-9_-]+)\/callback$/.exec(url.pathname);

  if (!match || !url.searchParams.get("state")?.startsWith("mcp.")) return null;
  const location = readMcpConfiguration(environment);
  const current = await readAuthConfiguration(environment, organizationIdentifier.parse(match[1]));

  if (!location || !current || url.origin !== new URL(current.configuration.redirectUrl).origin)
    return null;
  const target = new URL("/oauth/callback/company", location.issuer);

  for (const parameter of ["state", "code", "error", "iss"]) {
    const values = url.searchParams.getAll(parameter);

    if (values.length > 1) throw new SignInFailure("Invalid sign-in callback.");

    if (values[0])
      target.searchParams.set(parameter, parameter === "state" ? values[0].slice(4) : values[0]);
  }

  return redirect(target.href);
};

export const mcpLoginRequest = async (
  request: Request,
  environment: ParentEnvironment,
  context: ExecutionContext,
) => {
  const url = new URL(request.url);
  const location = readMcpConfiguration(environment);

  if (!location) return null;

  try {
    const bridge = await companyCallback(request, environment);

    if (bridge) return bridge;

    if (
      url.origin !== location.issuer ||
      ["/mcp", "/.well-known/oauth-protected-resource/mcp"].includes(url.pathname)
    )
      return null;
    const { server, storage, oauth } = mcpAuthorizationServer(environment);

    if (url.pathname === "/authorize" && request.method === "GET") {
      const original = await oauth.parseAuthRequest(request);
      const description = await oauth.describeConsent(original);
      const transaction = await oauth.beginConsent(original);
      const login = await readMcpLogin(environment);
      const sessions = await appSessions(request, environment);

      return mcpPage(
        {
          kind: "connect",
          handle: transaction.handle,
          clientName: description.clientName,
          redirectHost: description.redirectHost,
          redirectIsLoopback: description.redirectIsLoopback,
          providers: (["google", "microsoft"] as const).filter((name) => login[name]),
          accounts: sessions.map(({ configuration, identity }) => ({
            organizationId: configuration.organizationId,
            organizationName: configuration.organizationName ?? configuration.organizationId,
            name: identity.name || identity.email,
          })),
        },
        transaction.headers,
      );
    }

    if (url.pathname === "/oauth/continue" && request.method === "POST") {
      const input = await form(request);
      const handle = z.string().parse(input.get("handle"));

      const choice = z.string().parse(input.get("provider"));

      if (choice.startsWith("organization:")) {
        const organizationId = organizationIdentifier.parse(choice.slice("organization:".length));
        const sessions = await appSessions(request, environment);

        if (!sessions.some((session) => session.configuration.organizationId === organizationId))
          throw new SignInFailure(
            "Your previous sign-in has expired. Reconnect and choose a sign-in provider.",
          );
        const approved = await oauth.approveConsent(request, handle, { scope: ["mcp:services"] });

        return beginCompany(environment, approved.request, organizationId, approved.headers);
      }

      const provider = z.enum(["google", "microsoft", "widefleet", "cancel"]).parse(choice);

      if (provider === "cancel") {
        const denied = await oauth.denyConsent(request, handle);

        return redirect(denied.redirectTo, denied.headers);
      }

      const approved = await oauth.approveConsent(request, handle, { scope: ["mcp:services"] });
      const login = await readMcpLogin(environment);

      if (provider === "widefleet") {
        const transaction = await oauth.beginUpstream(approved.request, {
          headers: approved.headers,
          data: { stage: "widefleet" },
        });

        const target = new URL("/mcp/sign-in", login.platformUrl);
        target.searchParams.set("state", transaction.state);

        return redirect(target.href, transaction.headers);
      }

      const verifier = random();
      const nonce = random();

      const transaction = await oauth.beginUpstream(approved.request, {
        headers: approved.headers,
        data: { stage: "social", provider, verifier, nonce },
      });

      const social = socialOAuth(login, provider);

      return redirect(
        (await social.authorize(transaction.state, verifier, nonce)).href,
        transaction.headers,
      );
    }

    if (url.pathname === "/oauth/select" && request.method === "POST") {
      const input = await form(request);

      const resumed = await oauth.finishUpstream<unknown>(
        callbackRequest(request, z.string().parse(input.get("state"))),
      );

      const selection = upstream.parse(resumed.data);

      if (selection.stage !== "select")
        throw new SignInFailure("Restart the connection from your app.");

      return acceptSocial(
        environment,
        resumed.request,
        selection,
        organizationIdentifier.parse(input.get("organization")),
        resumed.headers,
      );
    }

    if (
      (url.pathname === "/oauth/organization" || url.pathname.startsWith("/oauth/callback/")) &&
      request.method === "GET"
    ) {
      if (
        ["state", "code", "error", "iss", "organization"].some(
          (name) => url.searchParams.getAll(name).length > 1,
        )
      )
        throw new SignInFailure("Invalid sign-in callback.");
      const resumed = await oauth.finishUpstream<unknown>(request);
      const data = upstream.parse(resumed.data);

      if (url.searchParams.has("error"))
        return redirect(
          authorizationErrorRedirect(resumed.request, "access_denied"),
          resumed.headers,
        );

      if (data.stage === "widefleet" && url.pathname === "/oauth/organization")
        return beginCompany(
          environment,
          resumed.request,
          organizationIdentifier.parse(url.searchParams.get("organization")),
          resumed.headers,
        );
      const code = z.string().min(1).max(16384).parse(url.searchParams.get("code"));

      if (
        data.stage === "company" &&
        url.pathname === `/oauth/callback/${data.provider ?? "company"}`
      ) {
        const company = await companyOAuth(
          await readMcpCompanyConfiguration(environment, data.organizationId, data.provider),
        );

        const credential = await company.exchange(code, data.verifier, data.nonce);

        if (data.expected && credential.authorization.identity.id !== data.expected.subject)
          throw new SignInFailure("Use the same company account to finish connecting.");

        return complete(
          environment,
          resumed.request,
          { organizationId: data.organizationId, provider: data.provider, credential },
          resumed.headers,
        );
      }

      if (data.stage !== "social" || url.pathname !== `/oauth/callback/${data.provider}`)
        throw new SignInFailure("Restart the connection from your app.");
      const social = socialOAuth(await readMcpLogin(environment), data.provider);
      const result = await social.exchange(code, data.verifier, data.nonce);
      const organizations = await matchingOrganizations(environment, result.identity);

      if (!organizations.length)
        throw new SignInFailure(
          "No company sign-in is configured for this account. If your organization uses Widefleet sign-in, reconnect and choose Continue with Widefleet.",
        );
      const selection = { stage: "select" as const, ...result, nonce: data.nonce };
      const first = organizations[0];

      if (organizations.length === 1 && first)
        return acceptSocial(
          environment,
          resumed.request,
          selection,
          first.organizationId,
          resumed.headers,
        );

      const transaction = await oauth.beginUpstream(resumed.request, {
        headers: resumed.headers,
        data: selection,
      });

      return mcpPage(
        {
          kind: "organizations",
          state: transaction.state,
          organizations: organizations.map((organization) => ({
            id: organization.organizationId,
            name: organization.organizationName ?? organization.organizationId,
          })),
        },
        transaction.headers,
      );
    }

    return server.fetch(request, storage, context);
  } catch (cause) {
    if (cause instanceof AuthorizationError && cause.redirectTo) return redirect(cause.redirectTo);

    const message =
      cause instanceof SignInFailure
        ? cause.message
        : "Sign-in could not be completed. Start a new connection from your app and try again.";

    return mcpPage({ kind: "error", message }, undefined, 400);
  }
};
