import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { userConnectionInvocation } from "@platform/contracts";
import { createTestEnvironment } from "./environment.ts";
import { createAppUserIdentity } from "../src/lib/server/app-user-identity.ts";
import { createUserConnections } from "../src/lib/server/user-connections.ts";
import { createAppService } from "../src/lib/server/apps.ts";
import { createApi } from "../src/lib/server/api.ts";
import { createRuntime } from "../src/lib/server/runtime-services.ts";
import { createStorage } from "../src/lib/server/storage.ts";
import { registerAppLogin } from "../src/lib/server/app-login-client.ts";
import { ssoProvider, user } from "../src/lib/server/auth-schema.ts";
import { apps, artifacts, deployments, organizationSettings } from "../src/lib/server/schema.ts";

const disconnected = { setup: "ready", connection: "disconnected", account: null };

describe("Personal connector accounts", () => {
  let environment: Awaited<ReturnType<typeof createTestEnvironment>>;
  let identify: ReturnType<typeof createAppUserIdentity>;
  const calls: z.infer<typeof userConnectionInvocation>[] = [];
  let status = 200;
  const reports: unknown[] = [];

  const principal = () => ({
    id: environment.owner.id,
    name: "Member",
    email: "owner@example.test",
    admin: false,
    creator: true,
    role: "member" as const,
    application: environment.application,
  });

  const service = () =>
    createUserConnections(
      environment.database.db,
      environment.configuration,
      identify,
      async (input) => {
        calls.push(input);

        if (status !== 200) return new Response(null, { status });

        switch (input.operation.action) {
          case "status":
            return Response.json(disconnected);
          case "prepare":
            return Response.json({
              url: `https://${input.hostname}/connect/start?ticket=synthetic`,
              expiresAt: new Date(Date.now() + 120_000).toISOString(),
            });
          case "disconnect":
            return Response.json({ disconnected: true });
        }
      },
      (_error, _distinctId, properties) => {
        reports.push(properties);
      },
    );

  const deploy = async (slug: string, entrypoints = ["UserConnection"], listed = true) => {
    const app = (
      await createAppService(environment.database.db, environment.configuration).create(
        principal(),
        { slug, displayName: slug, parentId: null },
      )
    ).unwrap();

    const artifactId = crypto.randomUUID();
    const deploymentId = crypto.randomUUID();
    await environment.database.db.insert(artifacts).values({
      id: artifactId,
      appId: app.id,
      metadata: { entrypoints },
      manifest: {},
      modules: [],
    });
    await environment.database.db.insert(deployments).values({
      id: deploymentId,
      appId: app.id,
      artifactId,
      status: "succeeded",
      requestId: crypto.randomUUID(),
    });
    await environment.database.db
      .update(apps)
      .set({ state: "active", activeDeploymentId: deploymentId, catalogListed: listed })
      .where(eq(apps.id, app.id));

    return { ...app, activeDeploymentId: deploymentId };
  };

  beforeAll(async () => {
    environment = await createTestEnvironment();
    identify = createAppUserIdentity(
      environment.database.db,
      environment.configuration,
      environment.settings,
    );
    await registerAppLogin(
      environment.database.db,
      environment.configuration,
      environment.encryption,
      "widefleet",
    );
    // App sign-in through Widefleet admits members with a verified email.
    await environment.database.db
      .update(user)
      .set({ emailVerified: true })
      .where(eq(user.id, environment.owner.id));
  });
  beforeEach(async () => {
    await environment.database.db.delete(apps);
    await environment.database.db.update(organizationSettings).set({ ssoRequired: false });
    calls.length = 0;
    reports.length = 0;
    status = 200;
  });
  afterAll(async () => {
    await environment.close();
  });

  it("lets ordinary members manage only opt-in connectors under their app identity", async () => {
    const visible = await deploy("visible");
    const ordinary = await deploy("ordinary", ["default"]);
    // Access rules decide who sees a connector; a catalog listing is not required.
    const unlisted = await deploy("unlisted", ["UserConnection"], false);
    await environment.database.db
      .update(apps)
      .set({ description: "Reads the shared mailbox." })
      .where(eq(apps.id, visible.id));
    // The catalog marks the published apps that are connectors.
    expect(
      (
        await createAppService(environment.database.db, environment.configuration).catalog(
          principal(),
        )
      )
        .unwrap()
        .map((entry) => [entry.displayName, entry.connector]),
    ).toEqual([
      ["ordinary", false],
      ["visible", true],
    ]);
    expect(await service().list(principal())).toEqual(
      [unlisted, visible].map((app) => ({
        appId: app.id,
        displayName: app.slug,
        // A connector's description comes with it, so the list can say what it is for.
        description: app.id === visible.id ? "Reads the shared mailbox." : null,
        hostname: app.hostname,
        activeDeploymentId: app.activeDeploymentId,
        status: disconnected,
        unavailable: false,
      })),
    );
    expect(calls[0]?.identity).toEqual({
      issuer: `${environment.configuration.PLATFORM_URL}/api/auth`,
      subject: environment.owner.id,
      name: "Member",
    });
    const prepared = await service().prepare(principal(), visible.id);
    expect(new URL(prepared.url).hostname).toBe(visible.hostname);
    expect(calls.at(-1)?.operation).toEqual({
      action: "prepare",
      completionUrl: `${environment.configuration.PLATFORM_URL}/widefleet/connections?completed=${visible.id}`,
    });
    await expect(service().prepare(principal(), ordinary.id)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(await service().disconnect(principal(), visible.id)).toEqual({ disconnected: true });
    const count = calls.length;
    await expect(
      service().disconnect(
        { ...principal(), application: { organizationId: "another-org", admin: true } },
        visible.id,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(calls).toHaveLength(count);
  });

  it("names the company account as the identity and refuses members without one", async () => {
    const app = await deploy("company");
    await environment.database.db.update(organizationSettings).set({ ssoRequired: true });
    await environment.database.db.update(ssoProvider).set({ domainVerified: true });

    const member = environment.users.createUser({
      name: "Company member",
      email: "company-member@example.test",
    });

    await environment.users.saveUser(member);
    const companyMember = { ...principal(), id: member.id, name: "Company member" };

    try {
      // A recovery session can reach the workspace without a company account.
      await expect(service().list(companyMember)).rejects.toMatchObject({ statusCode: 403 });
      await expect(service().prepare(companyMember, app.id)).rejects.toMatchObject({
        statusCode: 403,
      });
      expect(calls).toEqual([]);

      const objectId = crypto.randomUUID();
      await environment.linkMicrosoftUser(member.id, objectId);
      await service().list(companyMember);
      expect(calls[0]?.identity).toEqual({
        issuer: `${environment.environment.ENTRA_AUTHORITY}/${environment.environment.ENTRA_TENANT_ID}/v2.0`,
        subject: objectId,
        name: "Company member",
      });
    } finally {
      await environment.database.db.update(ssoProvider).set({ domainVerified: false });
    }
  });

  it("omits inaccessible connectors and distinguishes outages from disconnected accounts", async () => {
    const app = await deploy("visible");
    status = 404;
    expect(await service().list(principal())).toEqual([]);
    status = 503;
    expect(await service().list(principal())).toEqual([
      {
        appId: app.id,
        displayName: "visible",
        description: null,
        hostname: app.hostname,
        activeDeploymentId: app.activeDeploymentId,
        status: null,
        unavailable: true,
      },
    ]);
    // Unexpected failures are reported by kind, without connector responses.
    expect(reports).toEqual([
      { appId: app.id, organizationId: environment.application.organizationId, failure: "runtime" },
    ]);
    await expect(service().disconnect(principal(), app.id)).rejects.toMatchObject({
      statusCode: 503,
    });
  });

  it("authenticates the public API and rejects caller or return-URL overrides", async () => {
    const app = await deploy("api-visible");

    const user = environment.users.createUser({
      name: "Connector member",
      email: "connector-member@example.test",
    });

    await environment.users.saveUser(user);
    await environment.linkMicrosoftUser(user.id);
    const session = await environment.users.login({ userId: user.id });

    const runtime = await createRuntime({
      configuration: environment.configuration,
      database: environment.database,
      settings: environment.settings,
      reporting: environment.reporting,
      storage: createStorage(environment.configuration),
      encryption: environment.encryption,
    })();

    const api = createApi({ ...runtime, userConnections: service() });

    const request = (path: string, method = "GET", body?: Record<string, string>) => {
      const headers = new Headers(session.headers);
      headers.set("origin", environment.configuration.PLATFORM_URL);
      headers.set("content-type", "application/json");

      const options: RequestInit = { method, headers };

      if (body) options.body = JSON.stringify(body);

      return new Request(`${environment.configuration.PLATFORM_URL}/api/v1${path}`, options);
    };

    const path = `/user-connections/${app.id}`;
    expect((await api(request("/user-connections"))).status).toBe(200);
    expect(calls.at(-1)?.identity.subject).toBe(user.id);
    const connected = await api(request(`${path}/connect`, "POST", {}));
    expect(connected.status).toBe(200);
    expect(await connected.json()).toMatchObject({
      url: `https://${app.hostname}/connect/start?ticket=synthetic`,
    });
    expect((await api(request(path, "DELETE"))).status).toBe(200);
    const count = calls.length;
    expect(
      (
        await api(
          request(`${path}/connect`, "POST", {
            subject: environment.owner.id,
            completionUrl: "https://attacker.example.test",
          }),
        )
      ).status,
    ).toBe(400);
    const crossOrigin = request(path, "DELETE");
    crossOrigin.headers.set("origin", "https://attacker.example.test");
    expect((await api(crossOrigin)).status).toBe(403);
    const crossOrganization = request(path, "DELETE");
    crossOrganization.headers.set("X-Widefleet-Organization", "another-org");
    expect((await api(crossOrganization)).status).toBe(403);
    expect(
      (
        await api(
          new Request(`${environment.configuration.PLATFORM_URL}/api/v1${path}`, {
            method: "DELETE",
            headers: { origin: environment.configuration.PLATFORM_URL },
          }),
        )
      ).status,
    ).toBe(401);
    expect(calls).toHaveLength(count);
  });

  it("bounds connector concurrency and returns healthy results when the shared deadline expires", async () => {
    const healthy = await deploy("a-healthy");

    for (const name of ["b", "c", "d", "e", "f", "g"]) await deploy(`${name}-slow`);
    let active = 0;
    let peak = 0;
    let started = 0;

    const connections = createUserConnections(
      environment.database.db,
      environment.configuration,
      identify,
      async (input, signal) => {
        started++;
        active++;
        peak = Math.max(peak, active);

        try {
          if (input.appId === healthy.id) return Response.json(disconnected);

          if (!signal) throw new Error("Status checks must have a deadline");

          return await new Promise<Response>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        } finally {
          active--;
        }
      },
      (_error, _distinctId, properties) => {
        reports.push(properties);
      },
    );

    const results = await connections.list(principal());
    expect(results).toHaveLength(7);
    expect(results.find((entry) => entry.appId === healthy.id)?.status).toEqual(disconnected);
    expect(results.filter((entry) => entry.unavailable)).toHaveLength(6);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(4);
    expect(started).toBeLessThan(7);
    expect(active).toBe(0);
    // Checks cut off by the shared deadline are expected and not reported.
    expect(reports).toEqual([]);
  }, 10_000);
});
