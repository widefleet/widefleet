import { appIconSource, appPngIcons } from "@platform/contracts";
import type { ParentEnvironment, PublishedApp } from "./types.ts";

export const manifestPath = "/manifest.webmanifest";

const manifestLink = `<link rel="manifest" href="${manifestPath}">`;

const icons = [
  [appIconSource.path, "image/svg+xml"],
  ...appPngIcons.map((path) => [path, "image/png"] as const),
] as const;

// Install prompts on other sites, such as the Widefleet home, fetch an app's manifest
// and icons without cookies, so its name and icon are readable without signing in.
export const publicPaths = new Set<string>([manifestPath, ...icons.map(([path]) => path)]);

// The uploaded file itself: rewrite rules could otherwise answer with an app page.
const publicAsset = async (
  request: Request,
  environment: ParentEnvironment,
  app: PublishedApp,
  path: string,
) => {
  const entry = app.manifest[path];

  if (!entry) return new Response(null, { status: 404 });

  if (request.headers.get("if-none-match") === `"${entry.hash}"`)
    return new Response(null, { status: 304, headers: { etag: `"${entry.hash}"` } });
  const object = await environment.WIDEFLEET_PACKAGES.get(`apps/${app.appId}/assets/${entry.hash}`);

  if (!object) return new Response("Published asset is missing", { status: 502 });

  return new Response(object.body, {
    headers: {
      "content-type": icons.find(([icon]) => icon === path)?.[1] ?? "application/manifest+json",
      "cache-control": "no-cache",
      etag: `"${entry.hash}"`,
      "x-content-type-options": "nosniff",
    },
  });
};

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
      id: "/",
      name,
      start_url: "/",
      scope: "/",
      display: "standalone",
      icons: listed.filter((icon) => icon !== null),
    },
    { headers: { "content-type": "application/manifest+json", "cache-control": "no-cache" } },
  );
};

export const servePublic = async (
  request: Request,
  environment: ParentEnvironment,
  app: PublishedApp,
  path: string,
) => {
  if (path !== manifestPath || app.manifest[manifestPath])
    return publicAsset(request, environment, app, path);

  return app.displayName
    ? webManifest(environment, app, app.displayName)
    : new Response(null, { status: 404 });
};
