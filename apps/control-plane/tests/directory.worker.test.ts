import { build } from "esbuild";
import { Miniflare, Request as WorkerRequest, Response as WorkerResponse } from "miniflare";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { z } from "zod";

// Hosted installations search the company directory from a Worker, whose fetch accepts fewer
// redirect modes than Node's. This runs the directory in workerd and records what leaves it.
const tenant = "00000000-0000-4000-8000-000000000001";

const token = `https://login.example.test/${tenant}/oauth2/v2.0/token`;

const outbound: { url: string; authorization: string | null }[] = [];

let tokenAnswer: () => WorkerResponse;

let groupsAnswer: () => WorkerResponse;

let runtime: Miniflare;

beforeAll(async () => {
  const compiled = await build({
    stdin: {
      contents: `import { createDirectory } from '../src/lib/server/directory.ts';
        const identity = {
          provider: { type: 'entra', tenantId: '${tenant}', authority: 'https://login.example.test', label: 'Microsoft' },
          management: { clientId: 'login', clientSecret: 'synthetic-secret' },
          directory: { clientId: 'directory', clientSecret: 'directory-secret' },
          embeddingOrigins: [],
        };
        const creator = { id: 'creator', name: 'Creator', email: 'creator@example.test', role: 'member', admin: false, creator: true, application: { organizationId: 'widefleet', admin: false } };
        export default { async fetch() {
          // A new directory per request starts without a cached token.
          const result = await createDirectory(async () => identity).search(creator, { query: 'Finance', limit: 10 });
          return Response.json(result.isOk() ? { groups: result.value.groups } : { error: result.error.message });
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
          name: "directory",
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
                url: request.url.split("?")[0] ?? request.url,
                authorization: request.headers.get("authorization"),
              });

              if (request.url === token) return tokenAnswer();

              if (request.url.startsWith("https://graph.microsoft.com/v1.0/groups?"))
                return groupsAnswer();

              return new WorkerResponse(null, { status: 404 });
            },
          },
        },
      },
    ],
  });
});

afterAll(async () => runtime?.dispose());

const search = async () => {
  outbound.length = 0;

  return z
    .object({
      groups: z.array(z.object({ id: z.string(), name: z.string() })).optional(),
      error: z.string().optional(),
    })
    .parse(await (await runtime.dispatchFetch("https://worker.example.test/")).json());
};

const issued = () => WorkerResponse.json({ access_token: "directory-token", expires_in: 3600 });

const groups = () =>
  WorkerResponse.json({
    value: [{ id: "00000000-0000-4000-8000-0000000000aa", displayName: "Finance" }],
  });

it("searches groups with the directory's own token", async () => {
  tokenAnswer = issued;
  groupsAnswer = groups;

  expect(await search()).toEqual({
    groups: [{ id: "00000000-0000-4000-8000-0000000000aa", name: "Finance" }],
  });
  expect(outbound).toEqual([
    { url: token, authorization: null },
    {
      url: "https://graph.microsoft.com/v1.0/groups",
      authorization: "Bearer directory-token",
    },
  ]);
});

it("never follows a redirect from the token endpoint or Microsoft Graph", async () => {
  tokenAnswer = () => WorkerResponse.redirect("https://target.example.test/token", 302);
  groupsAnswer = groups;

  expect((await search()).error).toContain("could not authenticate");
  expect(outbound.map(({ url }) => url)).toEqual([token]);

  tokenAnswer = issued;
  groupsAnswer = () => WorkerResponse.redirect("https://target.example.test/groups", 302);

  expect((await search()).error).toContain("temporarily unavailable");
  expect(outbound.map(({ url }) => url)).toEqual([
    token,
    "https://graph.microsoft.com/v1.0/groups",
  ]);
});
