import { describe, expect, it } from "vitest";
import { configurationSchema } from "../src/lib/server/config.ts";
import { createDirectory } from "../src/lib/server/directory.ts";
import { installationSettings } from "./installation/settings.ts";
import { companyAccountProvider } from "../src/lib/server/company-identity.ts";
import { companyIdentity } from "../src/lib/server/company-identity.ts";

const creator = {
  id: "fixture-user",
  name: "Creator",
  email: "creator@example.test",
  role: "member" as const,
  admin: false,
  creator: true,
  company: undefined,
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
  it("returns native group IDs and names through one search contract and reuses the application token", async () => {
    const requests: Request[] = [];

    const directory = createDirectory(configuration, async (input, init) => {
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
    });

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

    const directory = createDirectory(configuration, transport);

    const denied = await directory.search(
      { ...creator, creator: false },
      { query: "Einkauf", limit: 10 },
    );

    expect(denied.isErr()).toBe(true);
    expect(calls).toBe(0);

    const disabled = createDirectory(
      { ...configuration, IDENTITY: { ...configuration.IDENTITY, directory: null } },
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
