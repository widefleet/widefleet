import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { parseSitemap } from "./sitemap.ts";

type IndexNowOptions = {
  sitemapFile: URL;
  sitemapUrl: string;
  key: string;
  endpoint: string;
  scope: "website" | "docs";
};

export function changedUrls(previous: Map<string, string>, next: Map<string, string>) {
  const changed = new Set<string>();

  for (const [url, lastmod] of next) {
    if (previous.get(url) !== lastmod) changed.add(url);
  }

  for (const url of previous.keys()) {
    if (!next.has(url)) changed.add(url);
  }

  return [...changed];
}

async function request(url: string, options: RequestInit = {}, acceptedStatuses = [200]) {
  for (let attempt = 0; attempt < 3; attempt++) {
    let response: Response;

    try {
      response = await fetch(url, {
        ...options,
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
      });
    } catch (cause) {
      if (attempt === 2) throw new Error(`Request failed: ${url}`, { cause });
      await sleep(1_000 * 2 ** attempt);
      continue;
    }

    if (acceptedStatuses.includes(response.status)) return response;

    const status = response.status;
    const retryAfter = response.headers.get("retry-after");
    await response.body?.cancel();

    const retryable = status === 408 || status === 429 || status >= 500;

    const requestedDelay = retryAfter
      ? Math.max(Number(retryAfter) * 1_000 || Date.parse(retryAfter) - Date.now(), 0)
      : 0;

    if (!retryable || attempt === 2 || requestedDelay > 10_000) {
      throw new Error(
        `HTTP ${status} from ${url}${retryAfter ? ` (Retry-After: ${retryAfter})` : ""}`,
      );
    }

    await sleep(Math.max(1_000 * 2 ** attempt, requestedDelay || 0));
  }

  throw new Error(`Request failed: ${url}`);
}

function validateScope(pages: Map<string, string>, options: IndexNowOptions) {
  const origin = new URL(options.sitemapUrl).origin;

  for (const location of pages.keys()) {
    const url = new URL(location);
    const isDocs = url.pathname === "/docs" || url.pathname.startsWith("/docs/");

    if (
      url.origin !== origin ||
      url.username ||
      url.password ||
      url.hash ||
      isDocs !== (options.scope === "docs")
    ) {
      throw new Error(`Sitemap URL is outside the ${options.scope} deployment: ${location}`);
    }
  }
}

export async function deployWithIndexNow(options: IndexNowOptions, deploy: () => Promise<void>) {
  // Capture the published sitemap before Wrangler replaces it. No Git history
  // or persistent change manifest is needed; lastmod is maintained with content.
  const next = parseSitemap(await readFile(options.sitemapFile, "utf8"));
  validateScope(next, options);

  const previousResponse = await request(options.sitemapUrl, {}, [200, 404]);

  const previous =
    previousResponse.status === 404
      ? new Map<string, string>()
      : parseSitemap(await previousResponse.text());

  if (previousResponse.status === 404) await previousResponse.body?.cancel();
  validateScope(previous, options);

  const urls = changedUrls(previous, next);
  console.log(`[IndexNow] ${urls.length} new, updated or removed URLs.`);

  await deploy();

  if (urls.length === 0) return;

  // Keep the exact batch in the build log: an IndexNow failure occurs after the
  // website is deployed. A new build alone cannot reconstruct this old sitemap.
  const origin = new URL(options.sitemapUrl).origin;

  const payload = {
    host: new URL(origin).host,
    key: options.key,
    keyLocation: `${origin}/${options.key}.txt`,
    urlList: urls,
  };

  console.log(
    `[IndexNow] Pending submission: ${JSON.stringify({ host: payload.host, urlList: urls })}`,
  );

  try {
    let published = false;

    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await request(options.sitemapUrl);
      const live = parseSitemap(await response.text());

      if (changedUrls(live, next).length === 0) {
        published = true;
        break;
      }

      if (attempt < 2) await sleep(2_000);
    }

    if (!published) throw new Error("The deployed sitemap does not match the new build.");

    const publishedKey = await request(payload.keyLocation)
      .then((response) => response.text())
      .catch(() => {
        // Request errors contain the URL, which would disclose the key in logs.
        throw new Error("The IndexNow verification file could not be fetched.");
      });

    if (publishedKey.trim() !== options.key) {
      throw new Error("The published IndexNow key does not match.");
    }

    const response = await request(
      options.endpoint,
      {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify(payload),
      },
      [200, 202],
    );

    await response.body?.cancel();

    const result = response.status === 202 ? "received; key validation pending" : "accepted";

    console.log(
      `[IndexNow] HTTP ${response.status}: ${urls.length} URLs ${result} at ${new Date().toISOString()}.`,
    );
  } catch (cause) {
    throw new Error(
      "Deployment succeeded, but IndexNow submission was not confirmed. Retry the pending batch from the build log; rebuilding an unchanged sitemap will not resend it.",
      { cause },
    );
  }
}
