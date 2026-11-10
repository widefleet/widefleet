import { templateRepository } from "./template-repository.fixture.ts";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import * as contract from "@platform/contracts";
import { Result } from "better-result";
import { createApi } from "../src/lib/server/api.ts";
import { deploymentCommand } from "../src/lib/server/deployment-execution.ts";
import { createRuntime, type Runtime } from "../src/lib/server/runtime-services.ts";
import { createStorage } from "../src/lib/server/storage.ts";
import { createTestEnvironment } from "./environment.ts";
import { memoryStorage } from "./memory-storage.fixture.ts";
import { AuthenticationFailed } from "../src/lib/server/identity.ts";

let environment: Awaited<ReturnType<typeof createTestEnvironment>>;

let runtime: Runtime;

const originalFetch = globalThis.fetch;

beforeAll(async () => {
  environment = await createTestEnvironment();
  runtime = await createRuntime({
    configuration: environment.configuration,
    database: environment.database,
    settings: environment.settings,
    storage: createStorage(environment.configuration, memoryStorage()),
    reporting: environment.reporting,
    encryptionKey: environment.environment.PLATFORM_ENCRYPTION_KEY,
  })();
});

beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));

    return (await templateRepository(url)) ?? originalFetch(input, init);
  });

  vi.spyOn(runtime.identity, "authenticate").mockResolvedValue(
    Result.ok({
      ...environment.owner,
      role: "owner",
      admin: true,
      creator: true,
      application: environment.application,
    }),
  );
});

afterEach(() => vi.restoreAllMocks());

afterAll(async () => environment?.close());

const request = (path: string, body: string) =>
  createApi(runtime)(
    new Request(`http://localhost/api/v1${path}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body,
    }),
  );

it("lets members discover templates without creating apps or granting management access", async () => {
  const principal = (
    await runtime.identity.authenticate(new Request("http://localhost"), "platform:read")
  ).unwrap();

  vi.mocked(runtime.identity.authenticate).mockResolvedValue(
    Result.ok({
      ...principal,
      role: "member",
      admin: false,
      creator: false,
      application: { ...principal.application, admin: false },
    }),
  );
  const create = vi.spyOn(runtime.apps, "create");
  const api = createApi(runtime);
  const listing = await api(new Request("http://localhost/api/v1/catalog/templates"));
  expect(listing.status).toBe(200);
  const catalog = contract.appTemplateCatalog.parse(await listing.json());
  expect(catalog.templates.map(({ id }) => id)).toEqual(["github", "gmail", "onedrive"]);
  expect(catalog.createPrompt).toContain(
    `--organization '${principal.application.organizationId}'`,
  );

  for (const { id } of catalog.templates) {
    const response = await api(new Request(`http://localhost/api/v1/catalog/templates/${id}`));
    expect(response.status).toBe(200);
    const template = contract.appTemplate.parse(await response.json());
    expect(template.id).toBe(id);
    expect(template.source).toBe(
      `https://github.com/widefleet/widefleet/tree/main/templates/${id}`,
    );
    expect(template.prompt).toContain(
      `--url '${environment.configuration.PLATFORM_URL}' --organization '${principal.application.organizationId}' catalog templates show ${id}`,
    );
    expect(template.markdown).toContain("AUTH_SECRET");
    expect(template.markdown).toContain("widefleet deploy");
    expect(template.markdown).toContain("## Use from another app");
    expect(template).not.toHaveProperty("instructions");
  }

  const filtered = await api(
    new Request("http://localhost/api/v1/catalog/templates?search=PRIVATE"),
  );

  expect(
    contract.appTemplateCatalog.parse(await filtered.json()).templates.map(({ id }) => id),
  ).toEqual(["github"]);
  const empty = await api(new Request("http://localhost/api/v1/catalog/templates?search=missing"));
  expect(contract.appTemplateCatalog.parse(await empty.json()).templates).toEqual([]);
  expect((await api(new Request("http://localhost/api/v1/catalog/templates/missing"))).status).toBe(
    404,
  );
  expect((await api(new Request("http://localhost/api/v1/catalog/templates/INVALID"))).status).toBe(
    400,
  );
  expect(create).not.toHaveBeenCalled();
  expect(runtime.identity.authenticate).toHaveBeenLastCalledWith(
    expect.any(Request),
    "platform:read",
  );
});

it("reads a new template from its directory and frontmatter without provider-specific fields", async () => {
  const markdown = "## Start\n\nCreate a board.\n\n```text\n---\n```\n";
  const requests: string[] = [];
  vi.mocked(globalThis.fetch).mockImplementation(async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    requests.push(url.href);

    if (url.hostname === "api.github.com")
      return Response.json([
        { type: "file", name: "README.md" },
        { type: "dir", name: "kanban" },
        { type: "dir", name: "no-template" },
        { type: "dir", name: "../outside" },
      ]);

    if (url.pathname.endsWith("/no-template/template.md"))
      return new Response(null, { status: 404 });

    return new Response(
      `\uFEFF---\r\nname: Team board\r\ndescription: >-\r\n  Organize tasks\r\n  together.\r\n---\r\n${markdown}`,
    );
  });
  const api = createApi(runtime);
  const listing = await api(new Request("http://localhost/api/v1/catalog/templates"));
  expect(listing.status).toBe(200);
  expect(contract.appTemplateCatalog.parse(await listing.json()).templates).toEqual([
    { id: "kanban", name: "Team board", description: "Organize tasks together." },
  ]);
  const response = await api(new Request("http://localhost/api/v1/catalog/templates/kanban"));
  expect(response.status).toBe(200);
  const template = contract.appTemplate.parse(await response.json());
  expect(template.markdown).toBe(markdown);
  expect(template.source).toBe("https://github.com/widefleet/widefleet/tree/main/templates/kanban");
  expect(template.prompt).toContain("catalog templates show kanban");
  expect(template.prompt).not.toMatch(/OAuth|personal account/i);
  expect(requests).not.toContainEqual(expect.stringContaining("outside"));
});

it.each([
  { status: 503, content: "" },
  { status: 200, content: "No frontmatter" },
  { status: 200, content: "---\nname: [broken\n---\nInstructions" },
  { status: 200, content: "---\nname: Gmail\n---\nInstructions" },
])("reports unavailable template content ($status, $content)", async ({ status, content }) => {
  vi.mocked(globalThis.fetch).mockResolvedValue(new Response(content, { status }));

  const response = await createApi(runtime)(
    new Request("http://localhost/api/v1/catalog/templates/gmail"),
  );

  expect(response.status).toBe(503);
});

it("reports a GitHub listing failure instead of an empty catalog", async () => {
  vi.mocked(globalThis.fetch).mockResolvedValue(new Response(null, { status: 403 }));

  const response = await createApi(runtime)(
    new Request("http://localhost/api/v1/catalog/templates"),
  );

  expect(response.status).toBe(503);
});

it.each(["/catalog/templates", "/catalog/templates/gmail"])(
  "requires authentication for %s",
  async (path) => {
    vi.mocked(runtime.identity.authenticate).mockResolvedValue(
      Result.err(new AuthenticationFailed({ code: "UNAUTHORIZED", message: "Sign in" })),
    );
    expect((await createApi(runtime)(new Request(`http://localhost/api/v1${path}`))).status).toBe(
      401,
    );
  },
);

it.each(["backend", "browser"])(
  "passes %s network changes through hosted command validation",
  async (target) => {
    const change = runtime.network.change;

    vi.spyOn(runtime.network, "change").mockImplementation((actor, appId, input) => {
      deploymentCommand.parse({
        kind: "network",
        id: crypto.randomUUID(),
        appId,
        actor,
        input,
        createdAt: new Date().toISOString(),
      });

      return change(actor, appId, input);
    });

    const actor = (
      await runtime.identity.authenticate(new Request("http://localhost"), "platform:write")
    ).unwrap();

    const app = (
      await runtime.apps.create(
        actor,
        contract.createAppInput.parse({
          slug: `network-${target}`,
          displayName: "Network fixture",
        }),
      )
    ).unwrap();

    for (const action of ["allow", "deny"]) {
      const response = await request(
        `/apps/${app.id}/network`,
        JSON.stringify({
          target,
          action,
          origins: ["https://api.example.test"],
        }),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        state: "saved",
        policy: { [target]: action === "allow" ? ["https://api.example.test"] : [] },
      });
    }
  },
);

it("passes access changes through hosted command validation", async () => {
  const change = runtime.appAccess.change;

  vi.spyOn(runtime.appAccess, "change").mockImplementation((actor, appId, input) => {
    deploymentCommand.parse({
      kind: "access",
      id: crypto.randomUUID(),
      appId,
      actor,
      input,
      createdAt: new Date().toISOString(),
    });

    return change(actor, appId, input);
  });

  const actor = (
    await runtime.identity.authenticate(new Request("http://localhost"), "platform:write")
  ).unwrap();

  const app = (
    await runtime.apps.create(
      actor,
      contract.createAppInput.parse({ slug: "access-change", displayName: "Access fixture" }),
    )
  ).unwrap();

  const initial = (await runtime.appAccess.read(actor, app.id)).unwrap();

  const response = await request(
    `/apps/${app.id}/access`,
    JSON.stringify({
      revision: initial.revision,
      groups: ["engineering"],
    }),
  );

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    state: "saved",
    revision: initial.revision + 1,
    groups: ["engineering"],
  });
});
