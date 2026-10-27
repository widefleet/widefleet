import { appAccessSnapshot } from "@platform/contracts";
import { z } from "zod";
import { createAuthentication, cookiePrefix } from "./authentication.ts";
import { authConfiguration, type AuthConfiguration } from "./configuration.ts";
import { proxyIdentity } from "./identity.ts";
import { authorization } from "./renewal.ts";

interface Apps {
  resolve: (hostname: string) => Promise<z.infer<typeof appAccessSnapshot> | null>;
  fetch: (request: Request) => Promise<Response>;
}

const response = (status: number, message: string) =>
  new Response(message, {
    status,
    headers: { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" },
  });

const redirect = (url: string, headers = new Headers()) => {
  headers.set("location", url);
  headers.set("cache-control", "no-store");

  return new Response(null, { status: 302, headers });
};

const unambiguousCookies = (headers: Headers, prefix: string) => {
  const names = new Set<string>();

  for (const cookie of (headers.get("cookie") ?? "").split(";")) {
    const name = cookie.trim().split("=")[0] ?? "";

    if (!name.startsWith(`__Secure-${prefix}.`) && name !== `__Host-${prefix}.oauth_state`)
      continue;

    if (names.has(name)) return false;
    names.add(name);
  }

  return true;
};

export const createAuthProxy = (input: AuthConfiguration, apps: Apps) => {
  const configuration = authConfiguration.parse(input);
  const callback = new URL(configuration.redirectUrl);
  const basePath = `/oauth2/${configuration.organizationId}`;

  const appUrl = (url: URL) =>
    url.protocol === "https:" &&
    url.port === callback.port &&
    !url.username &&
    !url.password &&
    url.hostname.endsWith(`.${configuration.domain}`) &&
    url.hostname !== callback.hostname;

  const returnUrl = async (value: string | null) => {
    const parsed = z.url().safeParse(value);

    if (!parsed.success) return null;
    const url = new URL(parsed.data);

    return appUrl(url) && (await apps.resolve(url.hostname)) ? url : null;
  };

  const loginUrl = (url: URL) => {
    const target = new URL(`${basePath}/start`, callback);

    target.searchParams.set("rd", url.href);

    return target.href;
  };

  const authentication = async (request: Request, url: URL) => {
    if (url.pathname === `${basePath}/error`)
      return response(401, "Company sign-in failed. Return to the app and try again.");

    if (url.pathname === `${basePath}/start` && request.method === "GET") {
      const target = await returnUrl(url.searchParams.get("rd"));

      if (!target) return response(400, "Choose a registered app to sign in.");
      const auth = await createAuthentication(configuration, true);

      const result = await auth.api.signInSocial({
        headers: request.headers,
        body: {
          provider: "company",
          callbackURL: target.href,
          errorCallbackURL: new URL(`${basePath}/error`, callback).href,
          disableRedirect: true,
        },
        asResponse: true,
      });

      if (!result.ok) return response(503, "Company sign-in is temporarily unavailable.");
      const destination = z.object({ url: z.url() }).parse(await result.json()).url;

      return redirect(destination, new Headers(result.headers));
    }

    if (url.pathname === `${basePath}/callback` && request.method === "GET") {
      if (["state", "code", "error"].some((key) => url.searchParams.getAll(key).length > 1))
        return response(400, "Invalid sign-in callback.");
      const auth = await createAuthentication(configuration, true);
      const internal = new URL(url);

      internal.pathname = `${basePath}/callback/company`;
      const result = await auth.handler(new Request(internal, request));
      const headers = new Headers(result.headers);

      headers.set("cache-control", "no-store");

      return new Response(result.body, { status: result.status, headers });
    }

    if (url.pathname === `${basePath}/sign_out` && request.method === "POST") {
      const auth = await createAuthentication(configuration, false);
      const internal = new URL(url);

      internal.pathname = `${basePath}/sign-out`;

      return auth.handler(new Request(internal, request));
    }

    return response(404, "Not found");
  };

  return {
    async fetch(request: Request) {
      const url = new URL(request.url);

      if (!unambiguousCookies(request.headers, cookiePrefix(configuration)))
        return response(400, "Ambiguous sign-in cookies.");

      if (url.origin === callback.origin) {
        try {
          return await authentication(request, url);
        } catch {
          return response(503, "Company sign-in is temporarily unavailable.");
        }
      }

      if (!appUrl(url)) return response(404, "Not found");
      const resolved = await apps.resolve(url.hostname);

      if (!resolved) return response(404, "Not found");
      const access = appAccessSnapshot.parse(resolved);

      if (url.pathname.startsWith("/oauth2/")) {
        if (url.pathname !== "/oauth2/start" || request.method !== "GET")
          return response(404, "Not found");
        const target = await returnUrl(url.searchParams.get("rd") ?? url.origin);

        return target ? redirect(loginUrl(target)) : response(400, "Invalid sign-in destination.");
      }

      const auth = await createAuthentication(configuration, false);
      const session = await auth.api.getSession({ headers: request.headers });
      const verified = authorization.safeParse(session?.user.appAuthorization);

      let user = verified.success
        ? proxyIdentity.safeParse(verified.data.identity)
        : proxyIdentity.safeParse(null);

      let renewed: Response | undefined;

      const finish = (result: Response) => {
        for (const cookie of renewed?.headers.getSetCookie() ?? [])
          result.headers.append("set-cookie", cookie);

        return result;
      };

      if (verified.success && verified.data.expiresAt <= Date.now()) {
        try {
          const refreshing = await createAuthentication(configuration, true);
          renewed = await refreshing.api.renewAppSession({
            headers: request.headers,
            asResponse: true,
          });

          if (renewed.status === 401) user = proxyIdentity.safeParse(null);
          else if (renewed.status === 403)
            return finish(response(403, "You do not have access to this app."));
          else if (!renewed.ok) {
            const unavailable = response(503, "Company sign-in is temporarily unavailable.");
            const retryAfter = renewed.headers.get("retry-after");

            if (retryAfter) unavailable.headers.set("retry-after", retryAfter);

            return finish(unavailable);
          } else user = proxyIdentity.safeParse(await renewed.json());
        } catch {
          return finish(response(503, "Company sign-in is temporarily unavailable."));
        }
      }

      if (!user.success) {
        return finish(
          request.headers.get("accept")?.includes("text/html")
            ? redirect(loginUrl(url))
            : response(401, "Sign in to access this app."),
        );
      }

      if (access.groups.length && !access.groups.some((group) => user.data.groups.includes(group)))
        return finish(response(403, "You do not have access to this app."));

      const headers = new Headers(request.headers);

      for (const key of request.headers.keys()) {
        if (
          ["cookie", "authorization", "proxy-authorization", "forwarded"].includes(key) ||
          key.startsWith("x-auth-request-") ||
          key.startsWith("x-forwarded-")
        )
          headers.delete(key);
      }

      headers.set("x-auth-request-user", user.data.id);
      headers.set("x-auth-request-preferred-username", user.data.name);
      headers.set("x-auth-request-email", user.data.email);
      headers.set("x-auth-request-groups", user.data.groups.join(","));

      const result = await apps.fetch(new Request(request, { headers })).catch((cause: unknown) => {
        if (!renewed?.headers.getSetCookie().length) throw cause;

        return response(502, "The app is temporarily unavailable.");
      });

      const outgoing = new Response(result.body, result);

      outgoing.headers.delete("set-cookie");

      return finish(outgoing);
    },
  };
};
