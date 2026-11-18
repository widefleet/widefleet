import {
  AuthorizationError,
  authorizationErrorRedirect,
  type AuthRequest,
} from "@cloudflare/workers-oauth-provider";
import { companyOAuth, companySession } from "@platform/auth-proxy/company-oauth";
import { readAuthConfiguration } from "@platform/auth-proxy/worker";
import { organizationIdentifier } from "@platform/contracts";
import { base64url } from "jose";
import { z } from "zod";
import {
  controlPlaneAvailable,
  discoverOrganizations,
  rememberOrganization,
  rememberedOrganizations,
} from "./mcp-discovery.ts";
import {
  mcpAuthorizationServer,
  mcpGrant,
  readMcpConfiguration,
  readMcpLogin,
  readMcpOrganization,
} from "./mcp-oauth.ts";
import { mcpPage } from "#mcp-ui";
import type { ParentEnvironment } from "./types.ts";

const random = () => base64url.encode(crypto.getRandomValues(new Uint8Array(32)));

const upstream = z.discriminatedUnion("stage", [
  z.object({ stage: z.literal("widefleet") }),
  z.object({
    stage: z.literal("company"),
    organizationId: organizationIdentifier,
    verifier: z.string(),
    nonce: z.string(),
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
  const reader = request.body?.getReader();
  const body = new Uint8Array(8192);
  let size = 0;

  if (reader)
    try {
      while (true) {
        const chunk = await reader.read();

        if (chunk.done) break;
        const value = z.instanceof(Uint8Array).parse(chunk.value);

        if (size + value.byteLength > body.byteLength) {
          await reader.cancel();
          throw new SignInFailure("Invalid sign-in request.");
        }

        body.set(value, size);
        size += value.byteLength;
      }
    } finally {
      reader.releaseLock();
    }

  const parameters = new URLSearchParams(new TextDecoder().decode(body.subarray(0, size)));

  if ([...parameters.keys()].some((key) => parameters.getAll(key).length !== 1))
    throw new SignInFailure("Invalid sign-in request.");

  return parameters;
};

const complete = async (
  environment: ParentEnvironment,
  browser: Request,
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

  await rememberOrganization(browser, environment, headers, grant.organizationId);

  return redirect(result.redirectTo, headers);
};

// Every route ends here: the organization's own registration signs the person in,
// so its assignment and access policies apply.
const beginCompany = async (
  environment: ParentEnvironment,
  request: AuthRequest,
  organizationId: string,
  headers: Headers,
  loginHint?: string,
) => {
  const company = await companyOAuth(await readMcpOrganization(environment, organizationId));
  const verifier = random();
  const nonce = random();
  const { oauth } = mcpAuthorizationServer(environment);

  const transaction = await oauth.beginUpstream(request, {
    headers,
    data: { stage: "company", organizationId, verifier, nonce },
  });

  const target = await company.authorize(`mcp.${transaction.state}`, verifier, nonce, loginHint);

  return redirect(target.href, transaction.headers);
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
      const accounts = await appSessions(request, environment);

      const signedIn = new Set(accounts.map(({ configuration }) => configuration.organizationId));

      return mcpPage(
        {
          kind: "connect",
          handle: transaction.handle,
          authorize: url.pathname + url.search,
          clientName: description.clientName,
          redirectHost: description.redirectHost,
          redirectIsLoopback: description.redirectIsLoopback,
          accounts: accounts.map(({ configuration, identity }) => ({
            organizationId: configuration.organizationId,
            organizationName: configuration.organizationName ?? configuration.organizationId,
            name: identity.name || identity.email,
          })),
          organizations: (await rememberedOrganizations(request, environment))
            .filter((configuration) => !signedIn.has(configuration.organizationId))
            .map((configuration) => ({
              id: configuration.organizationId,
              name: configuration.organizationName ?? configuration.organizationId,
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
        const remembered = await rememberedOrganizations(request, environment);

        if (
          ![...sessions.map(({ configuration }) => configuration), ...remembered].some(
            (configuration) => configuration.organizationId === organizationId,
          )
        )
          throw new SignInFailure(
            "This organization is no longer available here. Reconnect and enter your work email.",
          );
        const approved = await oauth.approveConsent(request, handle, { scope: ["mcp:services"] });

        return beginCompany(environment, approved.request, organizationId, approved.headers);
      }

      const option = z.enum(["email", "widefleet", "cancel"]).parse(choice);

      if (option === "cancel") {
        const denied = await oauth.denyConsent(request, handle);

        return redirect(denied.redirectTo, denied.headers);
      }

      if (option === "email") {
        const email = z.email().max(320).parse(input.get("email")?.trim());
        const organizations = await discoverOrganizations(environment, email);
        const [organization] = organizations;

        // A guest or a shared domain needs the person's Widefleet memberships to choose.
        if (organization && organizations.length === 1) {
          const approved = await oauth.approveConsent(request, handle, {
            scope: ["mcp:services"],
          });

          return beginCompany(
            environment,
            approved.request,
            organization.organizationId,
            approved.headers,
            email,
          );
        }
      }

      const login = await readMcpLogin(environment);

      if (input.get("confirmed") !== "1" && !(await controlPlaneAvailable(login.platformUrl)))
        return mcpPage({
          kind: "unavailable",
          handle,
          authorize: z.string().startsWith("/authorize?").max(8192).parse(input.get("authorize")),
        });

      const approved = await oauth.approveConsent(request, handle, { scope: ["mcp:services"] });

      const transaction = await oauth.beginUpstream(approved.request, {
        headers: approved.headers,
        data: { stage: "widefleet" },
      });

      const target = new URL("/mcp/sign-in", login.platformUrl);
      target.searchParams.set("state", transaction.state);

      return redirect(target.href, transaction.headers);
    }

    if (
      (url.pathname === "/oauth/organization" || url.pathname === "/oauth/callback/company") &&
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

      if (data.stage !== "company" || url.pathname !== "/oauth/callback/company")
        throw new SignInFailure("Restart the connection from your app.");
      const code = z.string().min(1).max(16384).parse(url.searchParams.get("code"));

      const company = await companyOAuth(
        await readMcpOrganization(environment, data.organizationId),
      );

      const credential = await company.exchange(code, data.verifier, data.nonce);

      return complete(
        environment,
        request,
        resumed.request,
        { organizationId: data.organizationId, credential },
        resumed.headers,
      );
    }

    return server.fetch(request, storage, context);
  } catch (cause) {
    if (cause instanceof AuthorizationError && cause.redirectTo) return redirect(cause.redirectTo);

    if (!(cause instanceof SignInFailure) && !(cause instanceof AuthorizationError))
      console.error("MCP sign-in failed", {
        path: url.pathname,
        error: cause instanceof Error ? cause.name : "UnknownError",
        message:
          cause instanceof z.ZodError
            ? "Invalid sign-in data"
            : cause instanceof Error
              ? cause.message
              : "Unexpected sign-in failure",
        issues:
          cause instanceof z.ZodError
            ? cause.issues.map(({ code, path }) => ({ code, path }))
            : undefined,
      });

    const message =
      cause instanceof SignInFailure
        ? cause.message
        : "Sign-in could not be completed. Start a new connection from your app and try again.";

    return mcpPage({ kind: "error", message }, undefined, 400);
  }
};
