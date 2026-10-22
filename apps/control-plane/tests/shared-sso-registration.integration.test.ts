import { expect, it, vi } from "vitest";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { settingsInput } from "@platform/contracts";
import { createAuthProxy } from "@platform/auth-proxy";
import { ssoProvider } from "../src/lib/server/auth-schema.ts";
import { createTestEnvironment, organizationCredential } from "./environment.ts";
import { createIdentityProvider } from "./edge/auth-proxy-idp.ts";
import { editableSettings } from "./settings-input.ts";
import { EventEmitter, once } from "node:events";

const cookies = (response: Response) =>
  response.headers
    .getSetCookie()
    .filter((cookie) => !cookie.includes("Max-Age=0"))
    .map((cookie) => cookie.split(";")[0])
    .join("; ");

it("uses one native registration for company control-plane and independent app sign-in", async () => {
  const environment = await createTestEnvironment();
  const origin = environment.configuration.PLATFORM_URL;
  const appCallback = "https://auth.apps.localhost/oauth2/widefleet/callback";

  const provider = await createIdentityProvider(
    [`${origin}/api/auth/sso/callback/shared-company`, appCallback],
    false,
  );

  try {
    await environment.database.db.delete(ssoProvider);
    const { headers } = await environment.users.login({ userId: environment.owner.id });
    await environment.settings.initialize(
      settingsInput.parse({
        sso: {
          providerId: "shared-company",
          issuer: provider.origin,
          domain: "example.test",
          oidcConfig: {
            clientId: "app-login",
            clientSecret: "synthetic-client-secret",
            scopes: ["openid", "profile", "email", "groups"],
            mapping: { name: "display_name", email: "mail", extraFields: { groups: "roles" } },
          },
        },
      }),
      "widefleet",
      { auth: environment.auth, headers },
    );
    // DNS verification has its own native integration test. This fixture starts
    // with a verified company and exercises both actual authorization-code flows.
    await environment.database.db
      .update(ssoProvider)
      .set({ domainVerified: true })
      .where(eq(ssoProvider.organizationId, "widefleet"));
    await environment.settings.activateSso({
      ...environment.owner,
      role: "owner",
      admin: true,
      creator: true,
      application: { organizationId: "widefleet", admin: true },
    });

    const started = await environment.auth.handler(
      new Request(`${origin}/api/auth/sign-in/sso`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ providerId: "shared-company", callbackURL: "/apps" }),
      }),
    );

    expect(started.status).toBe(200);
    const { url } = z.object({ url: z.url() }).parse(await started.json());
    expect(new URL(url).searchParams.get("client_id")).toBe("app-login");
    expect(new URL(url).searchParams.get("scope")?.split(" ")).toContain("groups");
    const authorized = await fetch(url, { redirect: "manual" });

    const completed = await environment.auth.handler(
      new Request(z.url().parse(authorized.headers.get("location")), {
        headers: { cookie: cookies(started) },
      }),
    );

    expect(completed.headers.get("location")).toBe("/apps");
    expect(
      (
        await environment.auth.api.getSession({
          headers: new Headers({ cookie: cookies(completed) }),
        })
      )?.session.identityOrganizationId,
    ).toBe("widefleet");

    const configuration = environment.authControl.read().configuration;

    if (!configuration) throw new Error("Missing published app configuration");
    expect(configuration.clientId).toBe("app-login");
    expect(configuration.clientSecret).toBe("synthetic-client-secret");
    expect(configuration.provider).toMatchObject({
      nameClaim: "display_name",
      emailClaim: "mail",
      groupsClaim: "roles",
    });
    const appUrl = "https://ledger.apps.localhost/";

    const proxy = createAuthProxy(configuration, {
      resolve: async (hostname) =>
        hostname === "ledger.apps.localhost" ? { revision: 1, groups: ["accounting"] } : null,
      fetch: async () => new Response("Company app"),
    });

    // The proxy receives only the published configuration; there is no control-plane request.
    const appStart = await proxy.fetch(
      new Request(
        `https://auth.apps.localhost/oauth2/widefleet/start?rd=${encodeURIComponent(appUrl)}`,
      ),
    );

    expect(appStart.status).toBe(302);
    const appAuthorization = z.url().parse(appStart.headers.get("location"));
    expect(new URL(appAuthorization).searchParams.get("client_id")).toBe("app-login");
    expect(new URL(appAuthorization).searchParams.get("scope")?.split(" ")).toContain("groups");
    const appAuthorized = await fetch(appAuthorization, { redirect: "manual" });

    const appCompleted = await proxy.fetch(
      new Request(z.url().parse(appAuthorized.headers.get("location")), {
        headers: { cookie: cookies(appStart) },
      }),
    );

    expect(appCompleted.headers.get("location")).toBe(appUrl);

    const app = await proxy.fetch(
      new Request(appUrl, { headers: { cookie: cookies(appCompleted) } }),
    );

    expect(app.status).toBe(200);
    expect(await app.text()).toBe("Company app");
  } finally {
    await provider.stop();
    await environment.close();
  }
});

it("keeps the native provider and app claims together when settings saves overlap", async () => {
  const environment = await createTestEnvironment();
  const gate = new EventEmitter();
  const firstCommitted = once(gate, "committed");
  const releaseFirst = once(gate, "resume");
  const update = environment.auth.api.updateSSOProvider;

  // Pause after the real native transaction, before the remaining settings write.
  const intercepted = vi
    .spyOn(environment.auth.api, "updateSSOProvider")
    .mockImplementation(async (input) => {
      const result = await update(input);

      if (input?.body.oidcConfig?.mapping?.name === "first_name") {
        gate.emit("committed");
        await releaseFirst;
      }

      return result;
    });

  try {
    await environment.database.db.update(ssoProvider).set({ domainVerified: true });

    const { headers } = await organizationCredential(environment, {
      id: environment.owner.id,
      application: { organizationId: "widefleet" },
    });

    const credential = { auth: environment.auth, headers };
    const firstInput = editableSettings(await environment.settings.inspect());

    if (!firstInput.sso) throw new Error("Missing fixture provider");
    firstInput.sso.appIdentityType = "entra";
    firstInput.sso.oidcConfig.mapping.name = "first_name";
    firstInput.sso.oidcConfig.mapping.extraFields.groups = "first_groups";
    const secondInput = structuredClone(firstInput);

    if (!secondInput.sso) throw new Error("Missing fixture provider");
    secondInput.sso.appIdentityType = "oidc";
    secondInput.sso.oidcConfig.mapping.name = "second_name";
    secondInput.sso.oidcConfig.mapping.extraFields.groups = "second_groups";
    const first = environment.settings.initialize(firstInput, "widefleet", credential);

    try {
      await Promise.race([firstCommitted, first]);
      await environment.settings.initialize(secondInput, "widefleet", credential);
    } finally {
      gate.emit("resume");
      await first;
    }

    const saved = await environment.settings.inspect();
    expect(saved.settings).not.toHaveProperty("appIdentity");
    expect(saved.sso).toMatchObject({
      appIdentityType: "oidc",
      oidcConfig: { mapping: { name: "second_name", extraFields: { groups: "second_groups" } } },
    });
    expect(environment.authControl.read().configuration?.provider).toMatchObject({
      type: "oidc",
      nameClaim: "second_name",
      groupsClaim: "second_groups",
    });
  } finally {
    gate.emit("resume");
    intercepted.mockRestore();
    await environment.close();
  }
});
