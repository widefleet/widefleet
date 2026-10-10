import { createServer, get, type IncomingMessage } from "node:http";
import { arrayBuffer } from "node:stream/consumers";
import { appAccessSnapshot } from "@platform/contracts";

const maxHeaderSize = 512 * 1024;

const readSession = async (
  upstream: string,
  options: { headers: Headers; signal: AbortSignal },
) => {
  // OAuth2 Proxy returns all verified groups in response headers. Match the
  // server's limit on this client too; fetch's default is too small for overage.
  const incoming = await new Promise<IncomingMessage>((resolve, reject) => {
    get(
      upstream,
      { headers: Object.fromEntries(options.headers), signal: options.signal, maxHeaderSize },
      resolve,
    ).on("error", reject);
  });

  const headers = new Headers();

  for (const [name, values] of Object.entries(incoming.headersDistinct))
    for (const value of values ?? []) headers.append(name, value);
  const status = incoming.statusCode ?? 502;
  const body = await arrayBuffer(incoming);

  // The native client does not follow redirects; preserve the SSO response.
  return new Response([204, 205, 304].includes(status) ? null : body, { status, headers });
};

const identityHeaders = [
  "x-auth-request-user",
  "x-auth-request-email",
  "x-auth-request-preferred-username",
  "x-auth-request-groups",
];

export const authorizeAppRequest = async (
  request: Request,
  issuer: string | null,
  upstream = "http://127.0.0.1:4180/",
  send = readSession,
) => {
  const url = new URL(request.url);
  const encoded = url.searchParams.get("policy");

  if (url.pathname !== "/authorize" || !encoded || encoded.length > 400_000)
    return new Response("Invalid access policy", { status: 403 });
  let policy;

  try {
    policy = appAccessSnapshot.parse(
      JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")),
    );
  } catch {
    return new Response("Invalid access policy", { status: 403 });
  }

  if (!issuer || policy.provider !== issuer)
    return new Response("Sign-in configuration does not match the app access policy", {
      status: 403,
    });

  const headers = new Headers();

  for (const name of [
    "cookie",
    "user-agent",
    "accept",
    "x-forwarded-host",
    "x-forwarded-proto",
    "x-forwarded-uri",
    "x-forwarded-method",
  ])
    if (request.headers.has(name)) headers.set(name, request.headers.get(name) ?? "");

  const verified = await send(upstream, {
    headers,
    signal: AbortSignal.timeout(10_000),
  });

  if (!verified.ok) return verified;
  await verified.body?.cancel();

  // Identity comes exclusively from OAuth2 Proxy's verified session. Neither
  // caller-supplied identity headers nor app query parameters can supply it.
  const subject = verified.headers.get("x-auth-request-user");

  const groups = (verified.headers.get("x-auth-request-groups") ?? "")
    .split(",")
    .map((group) => group.trim());

  if (
    !subject ||
    !(
      policy.allAuthenticated ||
      policy.users.includes(subject) ||
      policy.groups.some((group) => groups.includes(group))
    )
  )
    return new Response("App access denied", { status: 403 });
  const authenticated = new Headers();

  for (const name of identityHeaders) {
    const value = verified.headers.get(name);

    if (value !== null) authenticated.set(name, value);
  }

  return new Response(null, { status: 202, headers: authenticated });
};

export const startAppAuthorizer = (
  issuer: () => string | null,
  port = 4181,
  upstream = "http://127.0.0.1:4180/",
) => {
  const server = createServer({ maxHeaderSize }, (incoming, outgoing) => {
    const respond = async () => {
      const headers = new Headers();

      for (const [name, value] of Object.entries(incoming.headers)) {
        if (Array.isArray(value)) for (const entry of value) headers.append(name, entry);
        else if (value !== undefined) headers.set(name, value);
      }

      const response = await authorizeAppRequest(
        new Request(`http://authorizer${incoming.url ?? "/"}`, { headers }),
        issuer(),
        upstream,
      );

      outgoing.statusCode = response.status;
      response.headers.forEach((value, name) => {
        if (!["set-cookie", "content-length", "transfer-encoding", "connection"].includes(name))
          outgoing.setHeader(name, value);
      });
      const cookies = response.headers.getSetCookie();

      if (cookies.length) outgoing.setHeader("set-cookie", cookies);
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    };

    void respond().catch(() => {
      outgoing.statusCode = 503;
      outgoing.end("Sign-in service unavailable");
    });
  });

  server.listen(port, "0.0.0.0");

  return server;
};
