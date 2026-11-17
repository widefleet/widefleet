// OAuth token requests authenticate with a code + PKCE or a refresh token.
// SvelteKit's global form check runs before hooks and cannot exempt one endpoint.
// Keep the same form-origin policy here, with only this cookie-free exception.
export const checkFormOrigin = (request: Request) => {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) return null;
  const type = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();

  // The API verifies Bearer credentials before considering browser cookies.
  // Bodyless token requests therefore belong to that authentication path.
  if (
    !type &&
    request.body === null &&
    request.headers.get("authorization")?.startsWith("Bearer ") &&
    new URL(request.url).pathname.startsWith("/api/v1/")
  )
    return null;

  if (
    type &&
    !["application/x-www-form-urlencoded", "multipart/form-data", "text/plain"].includes(type)
  )
    return null;
  const url = new URL(request.url);

  if (
    request.method === "POST" &&
    url.pathname === "/api/auth/oauth2/token" &&
    type === "application/x-www-form-urlencoded" &&
    !request.headers.has("cookie")
  )
    return null;

  if (request.headers.get("origin") === url.origin) return null;
  const message = `Cross-site ${request.method} form submissions are forbidden`;
  const options = { status: 403, headers: { "cache-control": "no-store" } };

  return request.headers.get("accept") === "application/json"
    ? Response.json({ message }, options)
    : new Response(message, options);
};
