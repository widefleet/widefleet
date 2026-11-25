import type { ParentEnvironment, PublishedApp } from "./types.ts";

export const manifestPath = "/manifest.webmanifest";

// Manifests are fetched without cookies unless the link asks for them; app pages require sign-in.
const manifestLink = `<link rel="manifest" href="${manifestPath}" crossorigin="use-credentials">`;

const icons = [
  ["/favicon.svg", "image/svg+xml"],
  ["/apple-touch-icon.png", "image/png"],
  ["/favicon.png", "image/png"],
] as const;

export const linksManifest = (app: PublishedApp, contentType: string | null) =>
  Boolean(app.displayName) && contentType?.startsWith("text/html") === true;

// Browsers offer to install a page that links a manifest. A link of the app's own takes precedence.
export const linkManifest = (app: PublishedApp, response: Response) => {
  if (
    response.status !== 200 ||
    !response.body ||
    !linksManifest(app, response.headers.get("content-type"))
  )
    return response;
  let linked = false;

  const rewritten = new HTMLRewriter()
    .on('link[rel~="manifest"]', {
      element: () => {
        linked = true;
      },
    })
    .on("head", {
      element: (head) => {
        head.onEndTag((end) => {
          if (!linked) end.before(manifestLink, { html: true });
        });
      },
    })
    .transform(response);

  const result = new Response(rewritten.body, rewritten);
  result.headers.delete("content-length");

  return result;
};

// PNG stores its width and height at a fixed offset in the IHDR chunk.
const pngSize = async (environment: ParentEnvironment, app: PublishedApp, hash: string) => {
  const object = await environment.WIDEFLEET_PACKAGES.get(`apps/${app.appId}/assets/${hash}`, {
    range: { offset: 16, length: 8 },
  });

  if (!object) return null;
  const view = new DataView(await object.arrayBuffer());

  return view.byteLength === 8 ? `${view.getUint32(0)}x${view.getUint32(4)}` : null;
};

export const webManifest = async (
  environment: ParentEnvironment,
  app: PublishedApp,
  name: string,
) => {
  const listed = await Promise.all(
    icons.map(async ([src, type]) => {
      const entry = app.manifest[src];

      if (!entry) return null;
      const sizes = type === "image/svg+xml" ? "any" : await pngSize(environment, app, entry.hash);

      return sizes ? { src, type, sizes } : null;
    }),
  );

  return Response.json(
    {
      name,
      start_url: "/",
      scope: "/",
      display: "standalone",
      icons: listed.filter((icon) => icon !== null),
    },
    { headers: { "content-type": "application/manifest+json", "cache-control": "no-cache" } },
  );
};
