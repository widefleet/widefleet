export const forward = async (request: Request, origins: string[]) => {
  const target = new URL(request.url);

  if (
    target.protocol !== "https:" ||
    target.username ||
    target.password ||
    !origins.includes(target.origin)
  ) {
    console.warn("Network access denied", target.origin);

    return new Response("Network destination is not permitted", { status: 403 });
  }

  const headers = new Headers(request.headers);

  // Let the HTTP client derive authority from the checked URL, not app headers.
  for (const name of [
    "host",
    "connection",
    "proxy-authorization",
    "proxy-connection",
    "upgrade",
    "transfer-encoding",
    "x-forwarded-host",
  ])
    headers.delete(name);

  // The child fetch facade follows redirects by calling this gateway again.
  // Never let the privileged parent HTTP client follow one unchecked.
  return fetch(new Request(request, { headers, redirect: "manual" }));
};

// Drain a bounded replay copy concurrently. Request.clone() preserves celld's
// native HTTP stream on the first branch; a TransformStream would force the
// first upload through celld's complete JS-stream buffering fallback.
const replayableBody = (request: Request) => {
  const reader = request.clone().body?.getReader();
  const limit = 1024 * 1024;
  let chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  let complete = false;
  let retaining = true;

  const release = () => {
    retaining = false;
    chunks = [];
    void reader?.cancel().catch(() => undefined);
  };

  const copied = (async () => {
    if (!reader) return;

    while (retaining) {
      const result = await reader.read();
      const value: unknown = result.value;

      if (result.done) {
        complete = true;

        return;
      }

      if (!(value instanceof Uint8Array)) throw new TypeError("Upload chunks must be bytes");
      size += value.byteLength;

      if (size > limit) {
        release();

        return;
      }

      if (retaining) chunks.push(value.slice());
    }
  })().catch(release);

  return {
    release,
    async read() {
      await copied;

      if (!retaining || !complete)
        throw new TypeError("Redirect requires a fully sent request body of at most 1 MiB");

      return new Blob(chunks);
    },
  };
};

export const followRedirects = async (
  input: Request,
  send: (request: Request) => Promise<Response>,
) => {
  const mode = input.redirect;
  const replay = mode === "follow" && input.body ? replayableBody(input) : null;
  const initialOptions: RequestInit & { duplex: string } = { redirect: "manual", duplex: "half" };

  let request = new Request(input, initialOptions);
  let redirected = false;

  try {
    for (let count = 0; count <= 20; count++) {
      const response = await send(request);
      const location = response.headers.get("location");

      if (mode === "manual" || ![301, 302, 303, 307, 308].includes(response.status) || !location) {
        Object.defineProperties(response, {
          url: { value: request.url },
          redirected: { value: redirected },
        });

        return response;
      }

      await response.body?.cancel();

      if (mode === "error") throw new TypeError("Fetch returned a redirect");

      if (count === 20) throw new TypeError("Too many redirects");
      const target = new URL(location, request.url);
      const headers = new Headers(request.headers);

      const rewrite =
        (response.status === 303 && !["GET", "HEAD"].includes(request.method)) ||
        ([301, 302].includes(response.status) && request.method === "POST");

      if (target.origin !== new URL(request.url).origin)
        for (const name of ["authorization", "cookie", "proxy-authorization"]) headers.delete(name);

      if (rewrite) {
        replay?.release();

        for (const name of [
          "content-type",
          "content-length",
          "content-encoding",
          "content-language",
          "content-location",
        ])
          headers.delete(name);
      }

      const options = {
        method: rewrite ? "GET" : request.method,
        headers,
        body: rewrite || !request.body ? null : ((await replay?.read()) ?? null),
        signal: request.signal,
        // SAFETY: This redirect mode is a fixed literal controlled by the platform.
        redirect: "manual" as const,
        duplex: "half",
      };

      request = new Request(target, options);
      redirected = true;
    }
  } finally {
    replay?.release();
  }

  throw new TypeError("Too many redirects");
};
