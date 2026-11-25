import { build } from "esbuild";
import { Miniflare, Request as WorkerRequest, Response as WorkerResponse } from "miniflare";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { z } from "zod";

// Picture requests run on Workers, whose fetch accepts fewer options than Node's. This runs the
// shared helpers in workerd and records what actually leaves it.
const jpeg = [0xff, 0xd8, 0xff, 0xe0, 1, 2, 3];

const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 4, 5];

const outbound: { url: string; authorization: string | null }[] = [];

const answers = new Map<string, () => WorkerResponse>([
  [
    "https://login.example.test/.well-known/openid-configuration",
    () => WorkerResponse.json({ userinfo_endpoint: "https://login.example.test/userinfo" }),
  ],
  [
    "https://login.example.test/userinfo",
    () => WorkerResponse.json({ picture: "https://login.example.test/photo" }),
  ],
  ["https://login.example.test/photo", () => new WorkerResponse(new Uint8Array(jpeg))],
  [
    "https://graph.microsoft.com/v1.0/me/photos/120x120/$value",
    () => new WorkerResponse(new Uint8Array(png)),
  ],
  [
    "https://moved.example.test/.well-known/openid-configuration",
    () => WorkerResponse.json({ userinfo_endpoint: "https://moved.example.test/userinfo" }),
  ],
  [
    "https://moved.example.test/userinfo",
    () => WorkerResponse.redirect("https://target.example.test/userinfo", 302),
  ],
  [
    "https://login.example.test/moved",
    () => WorkerResponse.redirect("https://target.example.test/photo", 302),
  ],
]);

let runtime: Miniflare;

beforeAll(async () => {
  const compiled = await build({
    stdin: {
      contents: `import { fetchGraphPicture, fetchPictureUrl, providerPicture } from './picture.ts';
        const provider = (issuer) => ({ type: 'oidc', issuer, label: 'Company', nameClaim: 'name', emailClaim: 'email', groupsClaim: 'groups' });
        const result = (picture) => picture && picture !== 'none' ? { contentType: picture.contentType, bytes: Array.from(picture.bytes) } : picture;
        export default { async fetch(request) {
          const path = new URL(request.url).pathname;
          const token = 'synthetic-access-token';
          const picture =
            path === '/oidc' ? await providerPicture(provider('https://login.example.test'), {}, token)
            : path === '/graph' ? await fetchGraphPicture(token)
            : path === '/moved-user-info' ? await providerPicture(provider('https://moved.example.test'), {}, token)
            : await fetchPictureUrl(new URL('https://login.example.test/moved'), 'https://login.example.test', token);
          return Response.json({ picture: result(picture) });
        } };`,
      resolveDir: fileURLToPath(new URL(".", import.meta.url)),
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    mainFields: ["module", "main"],
    external: ["node:*"],
  });

  runtime = new Miniflare({
    telemetry: { enabled: false },
    workers: [
      {
        config: {
          name: "pictures",
          compatibilityDate: "2026-10-01",
          compatibilityFlags: ["nodejs_compat"],
          manifest: {
            mainModule: "worker.js",
            modules: {
              "worker.js": {
                type: "esm",
                contents: z.string().parse(compiled.outputFiles[0]?.text),
              },
            },
          },
        },
        dev: {
          outboundService: {
            type: "fetcher",
            handler: (request: WorkerRequest) => {
              outbound.push({
                url: request.url,
                authorization: request.headers.get("authorization"),
              });

              return (
                answers.get(request.url) ?? (() => new WorkerResponse(null, { status: 404 }))
              )();
            },
          },
        },
      },
    ],
  });
});

afterAll(async () => runtime?.dispose());

const run = async (path: string) => {
  outbound.length = 0;
  const response = await runtime.dispatchFetch(`https://worker.example.test${path}`);

  return z
    .object({
      picture: z
        .object({ contentType: z.string(), bytes: z.array(z.number()) })
        .nullable()
        .or(z.literal("none")),
    })
    .parse(await response.json()).picture;
};

it("copies an OIDC picture through discovery and user info", async () => {
  expect(await run("/oidc")).toEqual({ contentType: "image/jpeg", bytes: jpeg });
  expect(outbound).toEqual([
    { url: "https://login.example.test/.well-known/openid-configuration", authorization: null },
    { url: "https://login.example.test/userinfo", authorization: "Bearer synthetic-access-token" },
    { url: "https://login.example.test/photo", authorization: "Bearer synthetic-access-token" },
  ]);
});

it("copies the Microsoft Graph photo", async () => {
  expect(await run("/graph")).toEqual({ contentType: "image/png", bytes: png });
  expect(outbound).toEqual([
    {
      url: "https://graph.microsoft.com/v1.0/me/photos/120x120/$value",
      authorization: "Bearer synthetic-access-token",
    },
  ]);
});

it("never follows a redirect from user info or a picture URL", async () => {
  expect(await run("/moved-user-info")).toBeNull();
  expect(outbound.map(({ url }) => url)).toEqual([
    "https://moved.example.test/.well-known/openid-configuration",
    "https://moved.example.test/userinfo",
  ]);

  expect(await run("/moved-picture")).toBeNull();
  expect(outbound.map(({ url }) => url)).toEqual(["https://login.example.test/moved"]);
});
