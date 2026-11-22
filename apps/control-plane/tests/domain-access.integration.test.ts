import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { UnsecuredJWT, type JWTPayload } from "jose";
import { eq } from "drizzle-orm";
import { z } from "zod";
import * as contract from "@platform/contracts";
import { createTestEnvironment } from "./environment.ts";
import { createRuntime } from "../src/lib/server/runtime-services.ts";
import { createApi } from "../src/lib/server/api.ts";
import { createStorage } from "../src/lib/server/storage.ts";
import { account, member, organization, ssoProvider, user } from "../src/lib/server/auth-schema.ts";
import { organizationRuntimes, organizationSettings } from "../src/lib/server/schema.ts";
import type { SignIn } from "../src/lib/server/sso-policy.ts";

// Saved ID tokens come from the provider's token endpoint; only their claims matter here.
const idToken = (claims: JWTPayload) => new UnsecuredJWT(claims).encode();

const workTenant = "00000000-0000-4000-8000-000000000321";

describe("Joining organizations by company email domain", () => {
  let environment: Awaited<ReturnType<typeof createTestEnvironment>>;
  let runtime: Awaited<ReturnType<ReturnType<typeof createRuntime>>>;
  let api: ReturnType<typeof createApi>;
  const disabled = new Set<string>();

  beforeAll(async () => {
    environment = await createTestEnvironment();
    runtime = await createRuntime({
      configuration: environment.configuration,
      database: environment.database,
      settings: {
        ...environment.settings,
        publish: async () => ({
          ...(await environment.settings.inspect()),
          error: null,
          activation: { state: "active", message: "Synthetic publication", revision: "test" },
        }),
      },
      reporting: environment.reporting,
      storage: createStorage(environment.configuration),
      encryptionKey: environment.environment.PLATFORM_ENCRYPTION_KEY,
      sendEmail: async () => {},
      organizationAccess: {
        filterOrganizations: async (candidates) =>
          candidates.map(({ id }) => id).filter((id) => !disabled.has(id)),
      },
      createOrganization: async (ownerId, input) => {
        const id = crypto.randomUUID();
        await createOrganizationRecord(id, input.name, input.slug, ownerId);

        return { id, ...input };
      },
    })();
    api = createApi(runtime);
  });

  afterAll(async () => environment?.close());

  const database = () => environment.database.db;

  const createOrganizationRecord = async (
    id: string,
    name: string,
    slug: string,
    ownerId: string,
  ) => {
    await database().insert(organization).values({ id, name, slug, createdAt: new Date() });
    await database().insert(member).values({
      id: crypto.randomUUID(),
      organizationId: id,
      userId: ownerId,
      role: "owner",
      createdAt: new Date(),
    });
    await database()
      .insert(organizationRuntimes)
      .values({ organizationId: id, appHostnameSuffix: slug });
  };

  const person = async (email: string, verified = true) => {
    const created = environment.users.createUser({
      email,
      name: email.slice(0, email.indexOf("@")),
      emailVerified: verified,
    });

    await environment.users.saveUser(created);

    return created.id;
  };

  const linkProvider = async (userId: string, providerId: string, claims: JWTPayload) => {
    await database()
      .insert(account)
      .values({
        id: crypto.randomUUID(),
        providerId,
        accountId: crypto.randomUUID(),
        userId,
        idToken: idToken(claims),
      });
  };

  const googleWorkspace = (userId: string, email: string) =>
    linkProvider(userId, "widefleet-google", {
      email,
      email_verified: true,
      hd: email.split("@")[1],
    });

  const organizationOf = async (name: string, ownerId: string) => {
    const id = crypto.randomUUID();
    await createOrganizationRecord(id, name, name.toLowerCase().replaceAll(" ", "-"), ownerId);

    return id;
  };

  const signIn = (userId: string, identityOrganizationId: string | null = null): SignIn => ({
    userId,
    identityOrganizationId,
    recovery: false,
  });

  const principal = async (userId: string, organizationId: string) =>
    (await runtime.identity.principal(signIn(userId), organizationId)).unwrap();

  const verifyCompanyDomain = (organizationId: string, domain: string) =>
    database()
      .insert(ssoProvider)
      .values({
        id: crypto.randomUUID(),
        providerId: `company-${organizationId}`,
        organizationId,
        issuer: "https://sso.example.test",
        domain,
        domainVerified: true,
      });

  const request = async (
    userId: string,
    path: string,
    init: { method?: string; body?: unknown; organizationId?: string } = {},
  ) => {
    const headers = new Headers((await environment.users.login({ userId })).headers);
    headers.set("origin", environment.configuration.PLATFORM_URL);
    headers.set("content-type", "application/json");

    if (init.organizationId) headers.set("x-widefleet-organization", init.organizationId);

    return api(
      new Request(`${environment.configuration.PLATFORM_URL}/api/v1${path}`, {
        method: init.method ?? "GET",
        headers,
        body: init.body === undefined ? null : JSON.stringify(init.body),
      }),
    );
  };

  it("lets the creator open a new organization to a domain their Google Workspace sign-in proves", async () => {
    const owner = await person("owner@join.example.test");
    await googleWorkspace(owner, "owner@join.example.test");

    expect(await runtime.onboarding.domains(signIn(owner))).toEqual({
      joinDomain: "join.example.test",
      restricted: null,
    });

    const created = await runtime.onboarding.create(signIn(owner), {
      name: "Join Team",
      slug: "join-team",
      allowDomainJoin: true,
    });

    const [settings] = await database()
      .select({ joinDomains: organizationSettings.joinDomains })
      .from(organizationSettings)
      .where(eq(organizationSettings.organizationId, created.id));

    expect(settings?.joinDomains).toEqual(["join.example.test"]);

    const colleague = await person("colleague@join.example.test");
    const joinable = await runtime.domainAccess.joinable(signIn(colleague));

    expect(joinable).toEqual([
      {
        id: created.id,
        name: "Join Team",
        slug: "join-team",
        domain: "join.example.test",
        memberCount: 1,
        colleagues: ["owner"],
        verified: false,
      },
    ]);

    const response = await request(colleague, `/organizations/${created.id}/join`, {
      method: "POST",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ organizationId: created.id });

    const [membership] = await database()
      .select({ role: member.role })
      .from(member)
      .where(eq(member.userId, colleague));

    expect(membership?.role).toBe("member");
    expect(await runtime.domainAccess.joinable(signIn(colleague))).toEqual([]);
  });

  it("requires provider proof of a company domain to open an organization to it", async () => {
    const codeOnly = await person("code@proof.example.test");
    await expect(
      runtime.onboarding.create(signIn(codeOnly), {
        name: "Code Team",
        slug: "code-team",
        allowDomainJoin: true,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(
      await database().select().from(organization).where(eq(organization.slug, "code-team")),
    ).toEqual([]);

    const consumer = await person("consumer@mail.example.test");
    await linkProvider(consumer, "widefleet-microsoft", {
      email: "consumer@mail.example.test",
      tid: "9188040d-6c67-4c5b-b112-36a304b66dad",
      xms_edov: "1",
    });
    const personal = await person("personal@gmail.example.test");
    await linkProvider(personal, "widefleet-google", {
      email: "personal@gmail.example.test",
      email_verified: true,
    });

    for (const userId of [codeOnly, consumer, personal])
      expect((await runtime.onboarding.domains(signIn(userId))).joinDomain).toBeNull();

    const work = await person("work@entra.example.test");
    await linkProvider(work, "widefleet-microsoft", {
      email: "work@entra.example.test",
      tid: workTenant,
      xms_edov: true,
    });
    expect((await runtime.onboarding.domains(signIn(work))).joinDomain).toBe("entra.example.test");

    // An unverified local address is not proven, whatever its linked account says.
    const unverified = await person("unverified@entra.example.test", false);
    await linkProvider(unverified, "widefleet-microsoft", {
      email: "unverified@entra.example.test",
      tid: workTenant,
      xms_edov: true,
    });
    expect((await runtime.onboarding.domains(signIn(unverified))).joinDomain).toBeNull();
  });

  it("shows organizations only to verified addresses on their domains and keeps company sign-ins limited", async () => {
    const owner = await person("owner@team.example.test");
    const team = await organizationOf("Team Domain", owner);
    await googleWorkspace(owner, "owner@team.example.test");
    const ownerPrincipal = await principal(owner, team);
    await runtime.domainAccess.addJoinDomain(ownerPrincipal, "team.example.test");

    const disabledOwner = await person("disabled-owner@team.example.test");
    const disabledTeam = await organizationOf("Disabled Domain", disabledOwner);
    await googleWorkspace(disabledOwner, "disabled-owner@team.example.test");
    await runtime.domainAccess.addJoinDomain(
      await principal(disabledOwner, disabledTeam),
      "team.example.test",
    );
    disabled.add(disabledTeam);

    const colleague = await person("colleague@team.example.test");
    expect((await runtime.domainAccess.joinable(signIn(colleague))).map(({ id }) => id)).toEqual([
      team,
    ]);

    const unverified = await person("unverified@team.example.test", false);
    expect(await runtime.domainAccess.joinable(signIn(unverified))).toEqual([]);
    await expect(runtime.domainAccess.join(signIn(unverified), team)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });

    const outsider = await person("outsider@elsewhere.example.test");
    expect(await runtime.domainAccess.joinable(signIn(outsider))).toEqual([]);
    await expect(runtime.domainAccess.join(signIn(outsider), team)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(runtime.domainAccess.join(signIn(colleague), disabledTeam)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });

    // An external guest's company sign-in stays limited to the organization that issued it.
    const companyOwner = await person("owner@company.example.test");
    const company = await organizationOf("Guest Company", companyOwner);
    await verifyCompanyDomain(company, "company.example.test");
    const guest = await person("guest@team.example.test");
    await database().insert(member).values({
      id: crypto.randomUUID(),
      organizationId: company,
      userId: guest,
      role: "member",
      createdAt: new Date(),
    });
    expect(await runtime.domainAccess.joinable(signIn(guest, company))).toEqual([]);
    await expect(runtime.domainAccess.join(signIn(guest, company), team)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect((await runtime.domainAccess.joinable(signIn(guest))).map(({ id }) => id)).toEqual([
      team,
    ]);
  });

  it("names only colleagues on the same domain and marks DNS-verified domains", async () => {
    const owner = await person("owner@verified-join.example.test");
    const team = await organizationOf("Verified Join", owner);
    await googleWorkspace(owner, "owner@verified-join.example.test");
    await verifyCompanyDomain(team, "verified-join.example.test");
    await runtime.domainAccess.addJoinDomain(
      await principal(owner, team),
      "verified-join.example.test",
    );

    const guest = await person("guest@partner.example.test");
    await database().insert(member).values({
      id: crypto.randomUUID(),
      organizationId: team,
      userId: guest,
      role: "member",
      createdAt: new Date(),
    });

    const [entry] = await runtime.domainAccess.joinable(
      signIn(await person("new@verified-join.example.test")),
    );

    expect(entry).toMatchObject({
      id: team,
      memberCount: 2,
      colleagues: ["owner"],
      verified: true,
    });
  });

  it("enforces the organization's member limit", async () => {
    const owner = await person("owner@full.example.test");
    const team = await organizationOf("Full Team", owner);
    await googleWorkspace(owner, "owner@full.example.test");
    await runtime.domainAccess.addJoinDomain(await principal(owner, team), "full.example.test");

    const filler = Array.from({ length: 99 }, (_, index) => ({
      id: crypto.randomUUID(),
      name: `Filler ${index}`,
      email: `filler-${index}@filler.example.test`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));

    await database().insert(user).values(filler);
    await database()
      .insert(member)
      .values(
        filler.map((entry) => ({
          id: crypto.randomUUID(),
          organizationId: team,
          userId: entry.id,
          role: "member",
          createdAt: new Date(),
        })),
      );

    const late = await person("late@full.example.test");
    await expect(runtime.domainAccess.join(signIn(late), team)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("lets administrators manage join domains they can prove through the API", async () => {
    const owner = await person("owner@settings.example.test");
    const team = await organizationOf("Settings Team", owner);
    const memberId = await person("member@settings.example.test");
    await database().insert(member).values({
      id: crypto.randomUUID(),
      organizationId: team,
      userId: memberId,
      role: "member",
      createdAt: new Date(),
    });

    const read = await request(owner, "/settings/domain-access", { organizationId: team });
    expect(contract.domainAccess.parse(await read.json())).toEqual({
      joinDomains: [],
      provableDomains: [],
      verifiedDomains: [],
      restrictOrganizationCreation: false,
    });

    const unproven = await request(owner, "/settings/join-domains", {
      method: "POST",
      organizationId: team,
      body: { domain: "settings.example.test" },
    });

    expect(unproven.status).toBe(403);

    await googleWorkspace(owner, "owner@settings.example.test");

    const other = await request(owner, "/settings/join-domains", {
      method: "POST",
      organizationId: team,
      body: { domain: "other.example.test" },
    });

    expect(other.status).toBe(403);

    const added = await request(owner, "/settings/join-domains", {
      method: "POST",
      organizationId: team,
      body: { domain: "settings.example.test" },
    });

    expect(added.status).toBe(200);
    expect(contract.domainAccess.parse(await added.json())).toMatchObject({
      joinDomains: ["settings.example.test"],
      provableDomains: ["settings.example.test"],
    });

    expect(
      (await request(memberId, "/settings/domain-access", { organizationId: team })).status,
    ).toBe(403);

    const restriction = await request(owner, "/settings/organization-creation", {
      method: "PUT",
      organizationId: team,
      body: { restricted: true },
    });

    expect(restriction.status).toBe(409);

    const joined = await person("joined@settings.example.test");
    await runtime.domainAccess.join(signIn(joined), team);

    const removed = await request(owner, "/settings/join-domains/settings.example.test", {
      method: "DELETE",
      organizationId: team,
    });

    expect(removed.status).toBe(200);
    expect(contract.domainAccess.parse(await removed.json()).joinDomains).toEqual([]);
    expect(await database().select().from(member).where(eq(member.userId, joined))).toHaveLength(1);

    const joinable = await request(
      await person("later@settings.example.test"),
      "/organizations/joinable",
    );

    expect(z.array(contract.joinableOrganization).parse(await joinable.json())).toEqual([]);
  });

  it("reserves new organizations on a verified domain for the verifying organization's administrators", async () => {
    const owner = await person("owner@reserved.example.test");
    const company = await organizationOf("Reserved Company", owner);
    await verifyCompanyDomain(company, "reserved.example.test");
    await googleWorkspace(owner, "owner@reserved.example.test");

    // An organization that opened the domain earlier keeps it.
    const earlyOwner = await person("early@reserved.example.test");
    const early = await organizationOf("Early Team", earlyOwner);
    await googleWorkspace(earlyOwner, "early@reserved.example.test");
    await runtime.domainAccess.addJoinDomain(
      await principal(earlyOwner, early),
      "reserved.example.test",
    );

    const response = await request(owner, "/settings/organization-creation", {
      method: "PUT",
      organizationId: company,
      body: { restricted: true },
    });

    expect(response.status).toBe(200);
    expect(contract.domainAccess.parse(await response.json())).toMatchObject({
      verifiedDomains: ["reserved.example.test"],
      restrictOrganizationCreation: true,
    });

    const employee = await person("employee@reserved.example.test");
    await googleWorkspace(employee, "employee@reserved.example.test");
    expect(await runtime.onboarding.available(signIn(employee))).toBe(false);
    expect(await runtime.onboarding.domains(signIn(employee))).toEqual({
      joinDomain: null,
      restricted: "reserved.example.test",
    });

    const shadow = runtime.onboarding.create(signIn(employee), {
      name: "Shadow Team",
      slug: "shadow-team",
    });

    await expect(shadow).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(shadow).rejects.toThrow(
      "Your company manages Widefleet organizations for reserved.example.test",
    );

    // Nobody can open another organization to the reserved domain, not even its owner.
    const created = await request(employee, "/organizations", {
      method: "POST",
      body: { name: "Shadow Team", slug: "shadow-team" },
    });

    expect(created.status).toBe(403);
    const elsewhere = await person("owner@outside.example.test");
    const outside = await organizationOf("Outside Team", elsewhere);
    await database().insert(member).values({
      id: crypto.randomUUID(),
      organizationId: outside,
      userId: owner,
      role: "admin",
      createdAt: new Date(),
    });
    await expect(
      runtime.domainAccess.addJoinDomain(await principal(owner, outside), "reserved.example.test"),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(
      (await runtime.domainAccess.read(await principal(owner, company))).provableDomains,
    ).toEqual(["reserved.example.test"]);

    // The verifying organization's administrators can still create organizations, but
    // cannot open them to the reserved domain either.
    const administrator = await person("admin@reserved.example.test");
    await googleWorkspace(administrator, "admin@reserved.example.test");
    await database().insert(member).values({
      id: crypto.randomUUID(),
      organizationId: company,
      userId: administrator,
      role: "admin",
      createdAt: new Date(),
    });
    expect(await runtime.onboarding.available(signIn(administrator))).toBe(true);
    expect(await runtime.onboarding.domains(signIn(administrator))).toEqual({
      joinDomain: null,
      restricted: null,
    });
    await expect(
      runtime.onboarding.create(signIn(administrator), {
        name: "Admin Team",
        slug: "admin-team",
        allowDomainJoin: true,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect((await runtime.domainAccess.joinable(signIn(employee))).map(({ id }) => id)).toContain(
      early,
    );
  });

  it("keeps domain access closed on installations without self-service organizations", async () => {
    const owner = await person("owner@closed.example.test");
    await googleWorkspace(owner, "owner@closed.example.test");

    await expect(environment.domainAccess.joinable(signIn(owner))).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(environment.domainAccess.join(signIn(owner), "widefleet")).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(await environment.onboarding.domains(signIn(owner))).toEqual({
      joinDomain: null,
      restricted: null,
    });
  });
});
