import { describe, expect, it, vi } from "vitest";
import { configurationSchema } from "../src/lib/server/config.ts";
import { createDirectory } from "../src/lib/server/directory.ts";
import { installationSettings } from "./installation/settings.ts";
import { companyAccountProvider } from "../src/lib/server/company-identity.ts";
import { companyIdentity } from "../src/lib/server/company-identity.ts";
import { exportPKCS8, generateKeyPair } from "jose";

const creator = {
  id: "fixture-user",
  name: "Creator",
  email: "creator@example.test",
  role: "member" as const,
  admin: false,
  creator: true,
  application: {
    organizationId: "widefleet",
    admin: false,
  },
};

const configuration = {
  ...configurationSchema.parse({
    ...installationSettings,
    S3_ENDPOINT: "http://127.0.0.1:25400",
    S3_BUCKET: "artifacts",
  }),
  IDENTITY: companyIdentity.parse({
    provider: { type: "entra", tenantId: installationSettings.ENTRA_TENANT_ID, label: "Microsoft" },
    management: {
      clientId: installationSettings.ENTRA_CLIENT_ID,
      clientSecret: installationSettings.ENTRA_CLIENT_SECRET,
    },
    directory: { clientId: "directory", clientSecret: "directory-secret" },
  }),
};

describe("company directory", () => {
  it("replaces rejected Google tokens and shares concurrent exchanges after expiry", async () => {
    const keys = await generateKeyPair("RS256", { extractable: true });

    const identity = companyIdentity.parse({
      provider: { type: "google", domain: "example.test" },
      management: { clientId: "browser", clientSecret: "browser-secret" },
      directory: {
        clientId: "cache@fixture.iam.gserviceaccount.com",
        adminEmail: "admin@example.test",
        clientSecret: await exportPKCS8(keys.privateKey),
      },
    });

    let issued = 0;
    let rejected = "";

    const directory = createDirectory(
      async () => identity,
      async (input, init) => {
        const request = new Request(input, init);

        if (request.url.endsWith("/token")) {
          issued++;

          return Response.json({ access_token: `token-${issued}`, expires_in: 3600 });
        }

        if (request.headers.get("authorization") === rejected)
          return new Response(null, { status: 401 });

        return Response.json({ groups: [] });
      },
    );

    const search = () => directory.search(creator, { query: "Accounting", limit: 10 });

    expect((await search()).isOk()).toBe(true);
    expect(issued).toBe(1);
    rejected = "Bearer token-1";
    expect((await search()).isOk()).toBe(true);
    expect(issued).toBe(2);
    vi.useFakeTimers({ toFake: ["Date"] });

    try {
      vi.setSystemTime(Date.now() + 61 * 60 * 1000);
      const results = await Promise.all(Array.from({ length: 12 }, search));

      expect(results.every((result) => result.isOk())).toBe(true);
      expect(issued).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });
  it("uses Google directory credentials for authorized group search", async () => {
    const keys = await generateKeyPair("RS256", { extractable: true });

    const identity = companyIdentity.parse({
      provider: { type: "google", domain: "example.test" },
      management: { clientId: "browser", clientSecret: "browser-secret" },
      directory: {
        clientId: "directory@fixture.iam.gserviceaccount.com",
        adminEmail: "admin@example.test",
        clientSecret: await exportPKCS8(keys.privateKey),
      },
    });

    let calls = 0;

    const directory = createDirectory(
      async () => identity,
      async (input, init) => {
        calls++;
        const request = new Request(input, init);

        return request.url.endsWith("/token")
          ? Response.json({ access_token: "google-directory-token", expires_in: 3600 })
          : Response.json({ groups: [{ id: "accounting-id", name: "Accounting" }] });
      },
    );

    const result = await directory.search(creator, { query: "Accounting", limit: 10 });

    expect(result).toMatchObject({
      value: { groups: [{ id: "accounting-id", name: "Accounting", source: "Google Workspace" }] },
    });
    expect(calls).toBe(2);

    const denied = await directory.search(
      { ...creator, creator: false },
      { query: "Accounting", limit: 10 },
    );

    expect(denied).toMatchObject({ error: { code: "FORBIDDEN" } });
    expect(calls).toBe(2);
  });
  it("separates organization tokens and refreshes credentials after a configuration change", async () => {
    const identities = new Map([
      [
        "first",
        {
          ...configuration.IDENTITY,
          directory: { clientId: "first", clientSecret: "first-secret" },
        },
      ],
      [
        "second",
        {
          ...configuration.IDENTITY,
          directory: { clientId: "second", clientSecret: "second-secret" },
        },
      ],
    ]);

    const tokenRequests: string[] = [];
    const graphRequests: (string | null)[] = [];

    const directory = createDirectory(
      async (id) => identities.get(id) ?? null,
      async (input, init) => {
        const request = new Request(input, init);

        if (request.url.endsWith("/token")) {
          const secret = new URLSearchParams(await request.text()).get("client_secret") ?? "";
          tokenRequests.push(secret);

          return Response.json({ access_token: secret, expires_in: 3600 });
        }

        graphRequests.push(request.headers.get("authorization"));

        return Response.json({ value: [] });
      },
    );

    const search = async (id: string) => {
      const result = await directory.search(
        { ...creator, application: { organizationId: id, admin: false } },
        { query: "Team", limit: 10 },
      );

      expect(result.isOk()).toBe(true);
    };

    await search("first");
    await search("second");
    await search("first");
    identities.set("first", {
      ...configuration.IDENTITY,
      directory: { clientId: "first", clientSecret: "rotated-first-secret" },
    });
    await search("first");
    await search("second");
    expect(tokenRequests).toEqual(["first-secret", "second-secret", "rotated-first-secret"]);
    expect(graphRequests).toEqual([
      "Bearer first-secret",
      "Bearer second-secret",
      "Bearer first-secret",
      "Bearer rotated-first-secret",
      "Bearer second-secret",
    ]);
  });

  it("does not use installation directory credentials for another organization", async () => {
    let calls = 0;

    const directory = createDirectory(
      async (id) => (id === "widefleet" ? configuration.IDENTITY : null),
      async () => {
        calls++;

        return Response.json({ value: [] });
      },
    );

    const result = await directory.search(
      {
        ...creator,
        role: "admin",
        application: {
          ...creator.application,
          organizationId: "another-organization",
          admin: true,
        },
      },
      { query: "Engineering", limit: 10 },
    );

    expect(result).toMatchObject({ error: { _tag: "DirectoryUnavailable" } });
    expect(calls).toBe(0);
  });

  it("returns native group IDs and names through one search contract and reuses the application token", async () => {
    const requests: Request[] = [];

    const directory = createDirectory(
      async (id) => (id === "widefleet" ? configuration.IDENTITY : null),
      async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);

        if (request.url.endsWith("/token")) {
          const fields = new URLSearchParams(await request.text());
          expect(fields.get("grant_type")).toBe("client_credentials");
          expect(fields.get("client_secret")).toBe("directory-secret");

          return Response.json({ access_token: "fixture-token", expires_in: 3600 });
        }

        expect(request.headers.get("authorization")).toBe("Bearer fixture-token");
        expect(new URL(request.url).searchParams.get("$search")).toBe('"displayName:Einkauf"');

        return Response.json({
          value: [
            {
              id: "00000000-0000-4000-8000-000000000011",
              displayName: "Einkauf",
              description: "Procurement",
            },
            { id: "00000000-0000-4000-8000-000000000012", displayName: "Einkauf International" },
          ],
        });
      },
    );

    const results = await Promise.all([
      directory.search(creator, { query: "Einkauf", limit: 1 }),
      directory.search(creator, { query: "Einkauf", limit: 1 }),
    ]);

    for (const result of results) {
      expect(result.isOk()).toBe(true);

      if (result.isOk())
        expect(result.value).toEqual({
          groups: [
            {
              id: "00000000-0000-4000-8000-000000000011",
              name: "Einkauf",
              description: "Procurement",
              source: "Microsoft",
            },
          ],
          hasMore: true,
        });
    }

    expect(requests.filter((request) => request.url.endsWith("/token"))).toHaveLength(1);
  });

  it("distinguishes unavailable, unconfigured and forbidden searches from an empty directory", async () => {
    let calls = 0;

    const transport: typeof fetch = async () => {
      calls++;

      return new Response("permission denied with sensitive upstream details", { status: 403 });
    };

    const directory = createDirectory(
      async (id) => (id === "widefleet" ? configuration.IDENTITY : null),
      transport,
    );

    const denied = await directory.search(
      { ...creator, creator: false },
      { query: "Einkauf", limit: 10 },
    );

    expect(denied.isErr()).toBe(true);
    expect(calls).toBe(0);

    const disabled = createDirectory(
      async () => ({ ...configuration.IDENTITY, directory: null }),
      transport,
    );

    expect((await disabled.search(creator, { query: "Einkauf", limit: 10 })).isErr()).toBe(true);
    expect(calls).toBe(0);
    const failure = await directory.search(creator, { query: "Einkauf", limit: 10 });
    expect(failure.isErr()).toBe(true);

    if (failure.isErr()) expect(failure.error.message).not.toContain("sensitive upstream");
  });

  it("preserves existing Entra account keys while isolating generic OIDC issuers", () => {
    expect(companyAccountProvider(configuration.IDENTITY)).toBe("microsoft");

    const identity = (issuer: string) =>
      companyIdentity.parse({
        provider: { type: "oidc", issuer, label: "Company" },
        management: { clientId: "client", clientSecret: "secret" },
      });

    expect(companyAccountProvider(identity("https://login.example.test"))).toBe(
      companyAccountProvider(identity("https://login.example.test/")),
    );
    expect(companyAccountProvider(identity("https://login.example.test"))).not.toBe(
      companyAccountProvider(identity("https://another.example.test")),
    );
  });
});
