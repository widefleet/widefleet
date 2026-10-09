import { WorkerEntrypoint } from "cloudflare:workers";
import { readApp } from "./catalog.ts";
import type { ParentEnvironment, PublishedApp } from "./types.ts";

const contentTypes = new Map([
  ["html", "text/html; charset=utf-8"],
  ["css", "text/css; charset=utf-8"],
  ["js", "text/javascript; charset=utf-8"],
  ["mjs", "text/javascript; charset=utf-8"],
  ["json", "application/json"],
  ["txt", "text/plain; charset=utf-8"],
  ["svg", "image/svg+xml"],
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["gif", "image/gif"],
  ["webp", "image/webp"],
  ["avif", "image/avif"],
  ["ico", "image/x-icon"],
  ["woff", "font/woff"],
  ["woff2", "font/woff2"],
  ["ttf", "font/ttf"],
  ["otf", "font/otf"],
  ["wasm", "application/wasm"],
  ["pdf", "application/pdf"],
  ["xml", "application/xml"],
  ["webmanifest", "application/manifest+json"],
  ["mp4", "video/mp4"],
  ["mp3", "audio/mpeg"],
]);

const matchRule = (pattern: string, url: URL) => {
  const names: string[] = [];

  if ((pattern.match(/\*/g) ?? []).length > 1) throw new Error("Asset rules allow one wildcard");

  const expression = pattern
    .split(/(:[A-Za-z][A-Za-z0-9_]*|\*)/)
    .map((part) => {
      if (part === "*") {
        names.push("splat");

        return "(.*)";
      }

      if (/^:[A-Za-z]/.test(part)) {
        names.push(part.slice(1));

        return "([^/]+)";
      }

      return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("");

  const match = new RegExp(`^${expression}$`).exec(
    pattern.startsWith("/") ? url.pathname : `${url.origin}${url.pathname}`,
  );

  if (!match) return null;

  return new Map(names.map((name, index) => [name, match[index + 1] ?? ""]));
};

const substitute = (value: string, captures: Map<string, string>) =>
  value.replace(
    /:([A-Za-z][A-Za-z0-9_]*)/g,
    (token: string, name: string) => captures.get(name) ?? token,
  );

const rules = async (environment: ParentEnvironment, app: PublishedApp, name: string) => {
  const entry = app.manifest[name];

  if (!entry) return [];

  if (entry.size > 100 * 1024) throw new Error("Asset rule file exceeds 100 KiB");
  const object = await environment.WIDEFLEET_PACKAGES.get(`apps/${app.appId}/assets/${entry.hash}`);

  if (!object) throw new Error("Published asset rules are missing");

  return (await object.text())
    .split(/\r?\n/)
    .filter((line) => line.trim() && !line.trimStart().startsWith("#"));
};

const applyHeaders = (lines: string[], url: URL, headers: Headers) => {
  let captures: Map<string, string> | null = null;
  const assigned = new Set<string>();

  for (const line of lines) {
    if (!/^\s/.test(line)) {
      captures = matchRule(line.trim(), url);
      continue;
    }

    if (!captures) continue;
    const header = line.trim();
    const separator = header.indexOf(":");

    const name = (header.startsWith("!") ? header.slice(1) : header.slice(0, separator))
      .trim()
      .toLowerCase();

    if (["connection", "content-length", "transfer-encoding"].includes(name)) continue;

    if (header.startsWith("!")) {
      headers.delete(name);
      assigned.delete(name);
    } else if (separator > 0) {
      const value = substitute(header.slice(separator + 1).trim(), captures);

      if (assigned.has(name)) headers.append(name, value);
      else {
        headers.set(name, value);
        assigned.add(name);
      }
    }
  }
};

export const serveAsset = async (
  request: Request,
  environment: ParentEnvironment,
  app: PublishedApp,
) => {
  if (request.method !== "GET" && request.method !== "HEAD")
    return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });

  const url = new URL(request.url);
  const headerRules = await rules(environment, app, "/_headers");
  const redirectRules = await rules(environment, app, "/_redirects");
  let rewritten = false;

  // A 200 rule selects an asset once; the target is not a new public request.
  for (const line of redirectRules) {
    const [pattern, destination, code = "302"] = line.trim().split(/\s+/);

    if (!pattern || !destination) throw new Error("Invalid asset redirect rule");
    const captures = matchRule(pattern, url);

    if (!captures) continue;
    const target = new URL(substitute(destination, captures), url);
    const status = Number(code);

    if ([301, 302, 303, 307, 308].includes(status)) {
      const headers = new Headers({ location: target.href });
      applyHeaders(headerRules, new URL(request.url), headers);

      return new Response(null, { status, headers });
    }

    if (status !== 200 || target.origin !== url.origin)
      throw new Error("Asset rewrites require a local path and status 200");
    url.pathname = target.pathname;
    url.search = target.search;
    rewritten = true;
    break;
  }

  let path;

  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    return new Response(null, { status: 400 });
  }

  if (
    path.includes("\\") ||
    path.includes("\0") ||
    path.split("/").some((part) => part === "." || part === "..")
  )
    return new Response(null, { status: 400 });

  if (["/_headers", "/_redirects"].includes(path)) return new Response(null, { status: 404 });

  // Preserve the default native auto-trailing-slash behavior.
  let canonical = path;

  if (path.endsWith("/index.html") && app.manifest[path]) canonical = path.slice(0, -10);
  else if (path.endsWith(".html") && app.manifest[path]) canonical = path.slice(0, -5);
  else if (
    !path.endsWith("/") &&
    !app.manifest[path] &&
    !app.manifest[`${path}.html`] &&
    app.manifest[`${path}/index.html`]
  )
    canonical = `${path}/`;

  if (!rewritten && canonical !== path) {
    url.pathname = canonical;

    return new Response(null, { status: 307, headers: { location: url.href } });
  }

  if (!app.manifest[path])
    path =
      (path.endsWith("/") ? [`${path}index.html`] : [`${path}.html`, `${path}/index.html`]).find(
        (candidate) => app.manifest[candidate],
      ) ?? path;
  const entry = app.manifest[path];

  if (!entry) return new Response(null, { status: 404 });

  const headers = new Headers({
    "content-type":
      contentTypes.get(path.split(".").at(-1)?.toLowerCase() ?? "") ?? "application/octet-stream",
    "content-length": String(entry.size),
    "accept-ranges": "bytes",
    etag: `"${entry.hash}"`,
    "cache-control": "public, max-age=0, must-revalidate",
    "x-content-type-options": "nosniff",
  });

  applyHeaders(headerRules, new URL(request.url), headers);
  const etag = headers.get("etag");

  if (
    request.headers
      .get("if-none-match")
      ?.split(",")
      .some(
        (tag) =>
          tag.trim() === "*" ||
          (etag !== null && tag.trim().replace(/^W\//, "") === etag.replace(/^W\//, "")),
      )
  ) {
    headers.delete("content-length");

    return new Response(null, { status: 304, headers });
  }

  if (request.method === "HEAD") return new Response(null, { headers });

  let range: { offset: number; length: number } | undefined;
  const requested = request.headers.get("range");

  if (
    requested &&
    (!request.headers.has("if-range") ||
      (etag !== null && !etag.startsWith("W/") && request.headers.get("if-range") === etag))
  ) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(requested);

    if (match && (match[1] || match[2])) {
      const offset = match[1] ? Number(match[1]) : Math.max(0, entry.size - Number(match[2]));

      const end =
        match[1] && match[2] ? Math.min(entry.size - 1, Number(match[2])) : entry.size - 1;

      if (
        !Number.isSafeInteger(offset) ||
        !Number.isSafeInteger(end) ||
        offset > end ||
        offset >= entry.size
      ) {
        return new Response(null, {
          status: 416,
          headers: { "content-range": `bytes */${entry.size}` },
        });
      }

      range = { offset, length: end - offset + 1 };
      headers.set("content-range", `bytes ${offset}-${end}/${entry.size}`);
      headers.set("content-length", String(range.length));
    }
  }

  const object = await environment.WIDEFLEET_PACKAGES.get(
    `apps/${app.appId}/assets/${entry.hash}`,
    range ? { range } : {},
  );

  if (!object) return new Response("Published asset is missing", { status: 502 });

  return new Response(object.body, { status: range ? 206 : 200, headers });
};

export class Assets extends WorkerEntrypoint<ParentEnvironment, { version: string }> {
  override async fetch(request: Request) {
    const app = await readApp(this.env, this.ctx.props.version);

    if (!app) throw new Error("Published app is missing");

    return serveAsset(request, this.env, app);
  }
}
