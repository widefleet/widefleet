import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, test } from "vitest";
import { createTestHarness, unstable_readConfig, type Unstable_Config } from "wrangler";

const server = createTestHarness();

const router = createTestHarness();

const aliases = [
  { path: "/SKILL.md", contentType: "text/markdown; charset=utf-8", cors: null },
  { path: "/.well-known/agent-skills/index.json", contentType: "application/json", cors: null },
  { path: "/.well-known/ai-catalog.json", contentType: "application/json", cors: "*" },
  { path: "/.well-known/ard.json", contentType: "application/json", cors: "*" },
  {
    path: "/.well-known/api-catalog",
    contentType: 'application/linkset+json; profile="https://www.rfc-editor.org/info/rfc9727"',
    cors: "*",
  },
];

let fixture = "";

beforeAll(async () => {
  fixture = await mkdtemp(join(tmpdir(), "widefleet-docs-routing-"));

  const docs = join(fixture, "docs");
  const website = join(fixture, "website");

  await mkdir(join(docs, "scripts"), { recursive: true });
  await mkdir(website);
  await writeFile(
    join(website, "index.js"),
    'export default { fetch() { return new Response("Website fixture"); } };',
  );
  await writeFile(
    join(docs, "index.js"),
    'export default { fetch() { return new Response("Docs route"); } };',
  );
  await cp(
    new URL("../scripts/prepare-assets.ts", import.meta.url),
    join(docs, "scripts/prepare-assets.ts"),
  );
  await cp(new URL("../wrangler.jsonc", import.meta.url), join(docs, "wrangler.jsonc"));

  const files = {
    "index.html": "Docs fixture",
    "getting-started/quickstart/index.html": "Docs fixture",
    "404.html": "Docs not found",
    "SKILL.md": "# Generated skill fixture",
    ".well-known/agent-skills/index.json": '{"skills":[{"url":"/docs/SKILL.md"}]}',
    ".well-known/ai-catalog.json": '{"entries":[{"url":"/docs/openapi.json"}]}',
    ".well-known/ard.json": '{"entries":[{"url":"/docs/llms.txt"}]}',
    ".well-known/api-catalog": '{"linkset":[{"anchor":"/docs"}]}',
    "blume-assets/mark.svg": '<svg xmlns="http://www.w3.org/2000/svg"/>',
    _headers: `/docs/*.md
  Content-Type: text/markdown; charset=utf-8
/docs/
  Link: </docs/.well-known/api-catalog>; rel="api-catalog"
/docs/.well-known/api-catalog
  Content-Type: application/linkset+json; profile="https://www.rfc-editor.org/info/rfc9727"
/docs/.well-known/ai-catalog.json
  Access-Control-Allow-Origin: *
/docs/.well-known/ard.json
  Access-Control-Allow-Origin: *
/docs/.well-known/api-catalog
  Access-Control-Allow-Origin: *
/docs/blume-assets/*.svg
  Content-Security-Policy: sandbox
/docs/blume-assets/*.svg
  X-Content-Type-Options: nosniff
`,
  };

  for (const [path, content] of Object.entries(files)) {
    const destination = join(docs, "dist", path);

    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, content);
  }

  execFileSync(process.execPath, [join(docs, "scripts/prepare-assets.ts")]);

  // SAFETY: readConfig validates the file. Its declaration references an unshipped
  // workers-utils type; Wrangler exports the equivalent Config type itself.
  const config = unstable_readConfig({ config: join(docs, "wrangler.jsonc") }) as Unstable_Config;

  assert.ok(config.assets);
  assert.ok(config.routes);
  assert.ok(config.compatibility_date);

  // Wrangler 4.147's harness dispatches matching routes to the generated
  // assets-only script (a 404 stub), bypassing its asset router. Exercise the
  // actual route patterns with marker Workers, then the prepared assets with
  // the asset router. Neither harness can reach production.
  await server.update({
    root: docs,
    workers: [
      {
        config: {
          name: "docs-assets",
          compatibility_date: config.compatibility_date,
          assets: config.assets,
        },
      },
    ],
  });
  await router.update({
    workers: [
      // The default origin has no docs proxy or service bindings. The real docs
      // route patterns must select the docs Worker before this website fallback.
      {
        config: {
          name: "website-fixture",
          compatibility_date: "2026-10-05",
          main: join(website, "index.js"),
        },
      },
      {
        config: {
          name: "docs-route-fixture",
          main: join(docs, "index.js"),
          compatibility_date: config.compatibility_date,
          routes: config.routes,
        },
      },
    ],
  });
  await server.listen();
  await router.listen();
}, 30_000);

afterAll(async () => {
  await router.close();
  await server.close();

  if (fixture) await rm(fixture, { recursive: true, force: true });
});

test.each([
  "/docs",
  "/docs?source=website",
  "/docs/getting-started/quickstart",
  "/docs/getting-started/quickstart?source=website",
])("routes %s directly to the docs Worker", async (path) => {
  const route = await router.fetch(`https://widefleet.com${path}`, { redirect: "manual" });
  assert.equal(await route.text(), "Docs route");

  const response = await server.fetch(`https://widefleet.com${path}`, { redirect: "manual" });

  assert.equal(response.status, 200);
  assert.equal(await response.text(), "Docs fixture");
  assert.equal(response.headers.get("x-robots-tag"), null);
});

test.each(aliases)("serves $path with its generated content and headers", async (alias) => {
  for (const query of ["", "?version=1"]) {
    const route = await router.fetch(`https://widefleet.com${alias.path}${query}`, {
      redirect: "manual",
    });

    // Consume each harness response before starting another dispatch.
    assert.equal(await route.text(), "Docs route");

    const root = await server.fetch(`https://widefleet.com${alias.path}${query}`, {
      redirect: "manual",
    });

    const content = await root.text();

    const docs = await server.fetch(`https://widefleet.com/docs${alias.path}${query}`, {
      redirect: "manual",
    });

    assert.equal(root.status, 200);
    assert.equal(docs.status, 200);
    assert.equal(root.headers.get("location"), null);
    assert.equal(root.headers.get("content-type"), alias.contentType);
    assert.equal(root.headers.get("access-control-allow-origin"), alias.cors);
    assert.equal(root.headers.get("x-robots-tag"), null);
    assert.equal(content, await docs.text());
  }
});

test.each([
  "https://widefleet.com/",
  "https://widefleet.com/self-hosting",
  "https://widefleet.com/robots.txt",
  "https://widefleet.com/sitemap.xml",
  "https://widefleet.com/llms.txt",
  "https://widefleet.com/.well-known/security.txt",
  "https://widefleet.com/.well-known/agent-skills/other.json",
  "https://review.widefleet.com/docs",
  "https://review.widefleet.com/SKILL.md",
  "https://app.widefleet.com/docs",
  "https://example.com/docs",
])("keeps %s outside the production docs routes", async (url) => {
  const response = await router.fetch(url, { redirect: "manual" });

  assert.equal(await response.text(), "Website fixture");
});

test.each(["/docs/not-a-page", "/docs-missing", "/SKILL.md.bak", "/.well-known/api-catalog-extra"])(
  "returns a docs 404 for unknown paths under a reserved prefix: %s",
  async (path) => {
    const route = await router.fetch(`https://widefleet.com${path}`, { redirect: "manual" });

    const response = await server.fetch(`https://widefleet.com${path}`, { redirect: "manual" });

    assert.equal(await route.text(), "Docs route");
    assert.equal(response.status, 404);
    assert.equal(await response.text(), "Docs not found");
  },
);

test("preserves docs discovery and static asset headers", async () => {
  const home = await server.fetch("https://widefleet.com/docs", { redirect: "manual" });

  const svg = await server.fetch("https://widefleet.com/docs/blume-assets/mark.svg", {
    redirect: "manual",
  });

  assert.match(home.headers.get("link") ?? "", /api-catalog/u);
  assert.equal(svg.status, 200);
  assert.equal(svg.headers.get("content-security-policy"), "sandbox");
  assert.equal(svg.headers.get("x-content-type-options"), "nosniff");
});

test.each(["review.docs.widefleet.com", "a1b2c3-review.docs.widefleet.com"])(
  "serves independent docs and root aliases with noindex on %s",
  async (hostname) => {
    // Preview host routing is managed by Cloudflare. Exercise the same asset
    // deployment using the hostname of a named or unique Preview URL.
    for (const path of ["/docs", "/docs/not-a-page", ...aliases.map((alias) => alias.path)]) {
      const response = await server.fetch(`https://${hostname}${path}?version=1`, {
        redirect: "manual",
      });

      assert.equal(response.status, path === "/docs/not-a-page" ? 404 : 200);
      assert.equal(response.headers.get("x-robots-tag"), "noindex");
    }
  },
);
