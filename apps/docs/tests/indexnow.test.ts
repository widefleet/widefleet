import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, test, vi } from "vitest";
import { changedUrls, deployWithIndexNow } from "../scripts/indexnow.ts";
import { parseSitemap } from "../scripts/sitemap.ts";

function sitemap(origin: string, pages: [string, string][]) {
  return `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${pages
    .map(
      ([path, date]) =>
        `<url><loc>${origin}${path.replaceAll("&", "&amp;")}</loc><lastmod>${date}</lastmod></url>`,
    )
    .join("")}</urlset>`;
}

async function createFixture() {
  const directory = await mkdtemp(join(tmpdir(), "indexnow-test-"));
  const requests: string[] = [];
  const submissions: string[] = [];

  const state = {
    published: false,
    previous: "",
    next: "",
    previousStatus: 200,
    postStatus: 200,
    retryAfter: "",
    keyStatus: 200,
    retryOnce: false,
    dropSitemapPhase: "",
    key: "synthetic-indexnow-key",
    requests,
    submissions,
  };

  const server = createServer((request, response) => {
    state.requests.push(`${request.method} ${request.url}`);

    if (request.method === "POST" && request.url === "/indexnow") {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        body += chunk;
      });
      request.on("end", () => {
        state.submissions.push(body);

        if (state.retryAfter) response.setHeader("Retry-After", state.retryAfter);
        response.statusCode =
          state.retryOnce && state.submissions.length === 1 ? 503 : state.postStatus;
        response.end();
      });

      return;
    }

    if (request.url?.endsWith(".txt")) {
      response.statusCode = state.keyStatus;
      response.end(state.key);

      return;
    }

    if (state.dropSitemapPhase === (state.published ? "after" : "before")) {
      state.dropSitemapPhase = "";
      response.writeHead(200, { "Content-Type": "application/xml", "Content-Length": "1000" });
      response.write("<urlset>");
      setTimeout(() => response.destroy(), 25);

      return;
    }

    response.statusCode = state.published ? 200 : state.previousStatus;
    response.end(state.published ? state.next : state.previous);
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  // SAFETY: listen() above binds a TCP address, never a Unix socket path.
  const address = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${address.port}`;

  const options = {
    sitemapFile: pathToFileURL(join(directory, "sitemap.xml")),
    sitemapUrl: `${origin}/sitemap-pages.xml`,
    key: "synthetic-indexnow-key",
    endpoint: `${origin}/indexnow`,
    scope: "website" as const,
  };

  return {
    state,
    options,
    origin,
    async prepare(previous: [string, string][], next: [string, string][]) {
      state.previous = sitemap(origin, previous);
      state.next = sitemap(origin, next);
      await writeFile(options.sitemapFile, state.next);
    },
    async deploy() {
      state.requests.push("DEPLOY");
      state.published = true;
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(directory, { recursive: true, force: true });
    },
  };
}

let fixture: Awaited<ReturnType<typeof createFixture>>;

beforeEach(async () => {
  fixture = await createFixture();
});

afterEach(async () => {
  await fixture.close();
});

test("parses XML entities, namespaces and lastmod values without losing timestamps", () => {
  const xml = `<?xml version="1.0"?><s:urlset xmlns:s="http://www.sitemaps.org/schemas/sitemap/0.9">
    <s:url><s:lastmod>2026-10-16T08:00:00Z</s:lastmod><s:loc>https://example.test/a?x=1&amp;y=2</s:loc></s:url>
  </s:urlset>`;

  assert.deepEqual(
    [...parseSitemap(xml)],
    [["https://example.test/a?x=1&y=2", "2026-10-16T08:00:00Z"]],
  );
});

test("detects additions, removals, changed dates and rollback dates, while ignoring order", () => {
  const previous = new Map([
    ["/same", "2026-10-15"],
    ["/updated", "2026-10-15"],
    ["/deleted", "2026-10-15"],
    ["/rollback", "2026-10-16"],
  ]);

  const next = new Map([
    ["/new", "2026-10-16"],
    ["/same", "2026-10-15"],
    ["/updated", "2026-10-16"],
    ["/rollback", "2026-10-15"],
  ]);

  assert.deepEqual(changedUrls(previous, next), ["/new", "/updated", "/rollback", "/deleted"]);
});

test("accepts an explicitly empty urlset", () => {
  assert.equal(parseSitemap(sitemap("https://example.test", [])).size, 0);
});

test("rejects malformed XML, non-sitemaps, missing dates, duplicate URLs and entity declarations", () => {
  for (const xml of [
    "<urlset><url></urlset>",
    "<html><body>Service unavailable</body></html>",
    "<urlset>Service unavailable</urlset>",
    "<urlset><unexpected/></urlset>",
    '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"/>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://example.test/</loc></url></urlset>',
    sitemap("https://example.test", [
      ["/", "2026-10-16"],
      ["/", "2026-10-16"],
    ]),
    sitemap("https://example.test", [["/", "not-a-date"]]),
    sitemap("https://example.test", [["/", "2026-02-30"]]),
    '<!DOCTYPE urlset [<!ENTITY example "https://example.test">]><urlset/>',
  ])
    assert.throws(() => parseSitemap(xml));
});

test("submits exactly the changed batch after deployment and live sitemap verification", async () => {
  await fixture.prepare(
    [
      ["/", "2026-10-15"],
      ["/old", "2026-10-15"],
    ],
    [
      ["/", "2026-10-16"],
      ["/new", "2026-10-16"],
    ],
  );
  await deployWithIndexNow(fixture.options, () => fixture.deploy());
  assert.deepEqual(fixture.state.requests, [
    "GET /sitemap-pages.xml",
    "DEPLOY",
    "GET /sitemap-pages.xml",
    "GET /synthetic-indexnow-key.txt",
    "POST /indexnow",
  ]);
  assert.equal(
    fixture.state.submissions[0],
    JSON.stringify({
      host: new URL(fixture.origin).host,
      key: fixture.options.key,
      keyLocation: `${fixture.origin}/${fixture.options.key}.txt`,
      urlList: [`${fixture.origin}/`, `${fixture.origin}/new`, `${fixture.origin}/old`],
    }),
  );
});

test("deploys an unchanged sitemap without submitting URLs", async () => {
  await fixture.prepare([["/", "2026-10-16"]], [["/", "2026-10-16"]]);
  await deployWithIndexNow(fixture.options, () => fixture.deploy());
  assert.equal(fixture.state.published, true);
  assert.equal(fixture.state.submissions.length, 0);
});

test("never submits when Wrangler fails", async () => {
  await fixture.prepare([["/", "2026-10-15"]], [["/", "2026-10-16"]]);
  await assert.rejects(
    deployWithIndexNow(fixture.options, () => Promise.reject(new Error("deploy failed"))),
    /deploy failed/,
  );
  assert.equal(fixture.state.submissions.length, 0);
});

test("treats only a missing published sitemap as the first deployment", async () => {
  await fixture.prepare([], [["/", "2026-10-16"]]);
  fixture.state.previousStatus = 404;
  await deployWithIndexNow(fixture.options, () => fixture.deploy());
  assert.equal(fixture.state.submissions.length, 1);
});

test("does not deploy or infer deletions from an invalid published sitemap", async () => {
  await fixture.prepare([], [["/", "2026-10-16"]]);
  fixture.state.previous = "<html>Challenge page</html>";
  await assert.rejects(deployWithIndexNow(fixture.options, () => fixture.deploy()));
  assert.equal(fixture.state.published, false);
  assert.equal(fixture.state.submissions.length, 0);
});

test("does not deploy when the previous sitemap cannot be read", async () => {
  await fixture.prepare([], [["/", "2026-10-16"]]);
  fixture.state.previousStatus = 403;
  await assert.rejects(
    deployWithIndexNow(fixture.options, () => fixture.deploy()),
    /HTTP 403/,
  );
  assert.equal(fixture.state.published, false);
});

test("rejects foreign URLs and docs URLs in the website sitemap before deploying", async () => {
  for (const url of ["https://example.test/", `${fixture.origin}/docs/guide`]) {
    fixture.state.next = sitemap("", [[url, "2026-10-16"]]);
    await writeFile(fixture.options.sitemapFile, fixture.state.next);
    await assert.rejects(
      deployWithIndexNow(fixture.options, () => fixture.deploy()),
      /outside/,
    );
  }

  assert.equal(fixture.state.published, false);
});

test("allows the docs deployment to submit its own URLs", async () => {
  await fixture.prepare([["/docs", "2026-10-15"]], [["/docs", "2026-10-16"]]);
  await deployWithIndexNow({ ...fixture.options, scope: "docs" }, () => fixture.deploy());
  assert.equal(fixture.state.submissions.length, 1);
});

test("retries a transient IndexNow error with the same batch", async () => {
  await fixture.prepare([], [["/", "2026-10-16"]]);
  fixture.state.retryOnce = true;
  await deployWithIndexNow(fixture.options, () => fixture.deploy());
  assert.equal(fixture.state.submissions.length, 2);
  assert.equal(fixture.state.submissions[0], fixture.state.submissions[1]);
});

for (const retryAfter of ["", "600", "Fri, 16 Oct 2026 14:00:00 GMT"]) {
  test(`stops on rate limiting and preserves recovery instructions (${retryAfter || "no Retry-After"})`, async () => {
    await fixture.prepare([], [["/", "2026-10-16"]]);
    fixture.state.postStatus = 429;
    fixture.state.retryAfter = retryAfter;
    await assert.rejects(
      deployWithIndexNow(fixture.options, () => fixture.deploy()),
      (error: Error) => {
        assert.match(error.message, /Deployment succeeded, but IndexNow/);
        assert.ok(error.cause instanceof Error);
        assert.match(error.cause.message, /HTTP 429/);
        assert.ok(
          error.cause.message.includes(
            retryAfter ? `Retry-After: ${retryAfter}` : "wait at least 10 minutes",
          ),
        );

        return true;
      },
    );
    assert.equal(fixture.state.published, true);
    assert.equal(fixture.state.submissions.length, 1);
  });
}

test("reports an IndexNow rejection separately from a successful deployment", async () => {
  await fixture.prepare([], [["/", "2026-10-16"]]);
  fixture.state.postStatus = 403;
  await assert.rejects(
    deployWithIndexNow(fixture.options, () => fixture.deploy()),
    /Deployment succeeded, but IndexNow/,
  );
  assert.equal(fixture.state.published, true);
  assert.equal(fixture.state.submissions.length, 1);
});

for (const phase of ["before", "after"]) {
  test(`retries a sitemap body interrupted ${phase} deployment`, async () => {
    await fixture.prepare([], [["/", "2026-10-16"]]);
    fixture.state.dropSitemapPhase = phase;
    await deployWithIndexNow(fixture.options, () => fixture.deploy());
    assert.equal(fixture.state.dropSitemapPhase, "");
    assert.equal(fixture.state.submissions.length, 1);
    assert.deepEqual(fixture.state.requests, [
      "GET /sitemap-pages.xml",
      ...(phase === "before"
        ? ["GET /sitemap-pages.xml", "DEPLOY"]
        : ["DEPLOY", "GET /sitemap-pages.xml"]),
      "GET /sitemap-pages.xml",
      "GET /synthetic-indexnow-key.txt",
      "POST /indexnow",
    ]);
  });
}

test("does not submit while the deployed sitemap is stale", async () => {
  await fixture.prepare([], [["/", "2026-10-16"]]);
  await assert.rejects(
    deployWithIndexNow(fixture.options, async () => {}),
    /Deployment succeeded, but IndexNow/,
  );
  assert.equal(fixture.state.submissions.length, 0);
});

test("does not submit when the public key does not match", async () => {
  await fixture.prepare([], [["/", "2026-10-16"]]);
  fixture.state.key = "wrong-key";
  await assert.rejects(
    deployWithIndexNow(fixture.options, () => fixture.deploy()),
    /Deployment succeeded, but IndexNow/,
  );
  assert.equal(fixture.state.submissions.length, 0);
});

test("reports pending key validation without repeated submissions or key disclosure", async () => {
  await fixture.prepare([], [["/", "2026-10-16"]]);
  fixture.state.postStatus = 202;
  const messages: string[] = [];

  const logger = vi.spyOn(console, "log").mockImplementation((message: string) => {
    messages.push(message);
  });

  try {
    await deployWithIndexNow(fixture.options, () => fixture.deploy());
    assert.equal(fixture.state.submissions.length, 1);
    assert.match(messages.join("\n"), /HTTP 202:.*key validation pending/);
    assert.doesNotMatch(messages.join("\n"), /HTTP 200/);
    assert.ok(!messages.join("\n").includes(fixture.options.key));
    assert.ok(messages.some((message) => message.includes(`${fixture.origin}/`)));
  } finally {
    logger.mockRestore();
  }
});

test("does not disclose the key URL in a failed verification error", async () => {
  await fixture.prepare([], [["/", "2026-10-16"]]);
  fixture.state.keyStatus = 403;
  await assert.rejects(
    deployWithIndexNow(fixture.options, () => fixture.deploy()),
    (error: Error) => {
      assert.match(error.message, /Deployment succeeded, but IndexNow/);
      assert.ok(error.cause instanceof Error);
      assert.match(error.cause.message, /verification file could not be fetched/);
      assert.ok(!error.cause.message.includes(fixture.options.key));
      assert.equal(error.cause.cause, undefined);

      return true;
    },
  );
  assert.equal(fixture.state.submissions.length, 0);
});

test("production entrypoint rejects a missing key and extra arguments before running Wrangler", () => {
  const entry = new URL("../scripts/deploy.ts", import.meta.url);

  for (const args of [[], ["--dry-run"]]) {
    const result = spawnSync(process.execPath, [entry.pathname, ...args], {
      env: { PATH: "", INDEXNOW_KEY: args.length ? "synthetic-indexnow-key" : "" },
      encoding: "utf8",
      timeout: 5_000,
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, args.length ? /takes no arguments/ : /Set INDEXNOW_KEY/);
  }
});
