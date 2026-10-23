import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { cliConsent } from "../src/lib/server/cli-consent.ts";
import { cliCallbackUrl } from "../src/lib/server/cli-login.ts";
import { readCliContext, saveCliContext } from "../src/lib/server/cli-login-context.ts";
import { member, organization, verification } from "../src/lib/server/auth-schema.ts";
import { createTestEnvironment } from "./environment.ts";

const cloudOrigin = "https://app.widefleet.com";

const companyOrigin = "https://company.example.test";

const digest = (value: string) => createHash("sha256").update(value);

const scope = "openid profile offline_access platform:read platform:write";

describe("CLI browser handoff with real OAuth authorization and PostgreSQL", () => {
  let cloud: Awaited<ReturnType<typeof createTestEnvironment>>;
  let company: Awaited<ReturnType<typeof createTestEnvironment>>;

  beforeAll(async () => {
    cloud = await createTestEnvironment(cloudOrigin);
    company = await createTestEnvironment(companyOrigin);
  });
  afterAll(async () => {
    await cloud?.close();
    await company?.close();
  });

  const begin = async () => {
    const verifier = randomBytes(32).toString("base64url");
    const pollToken = randomBytes(32).toString("base64url");

    const input = {
      code_challenge: digest(verifier).digest("base64url"),
      poll_hash: digest(pollToken).digest("hex"),
      scope,
    };

    const started = await cloud.cliLogin.start(input);
    const url = new URL(started.verification_uri);
    const ticket = z.string().parse(url.searchParams.get("ticket"));

    return { input, verifier, pollToken, started, ticket };
  };

  const authorization = async (target: typeof company, url: string) => {
    const credential = await target.users.login({ userId: target.ownerId });
    const response = await target.auth.handler(new Request(url, { headers: credential.headers }));
    expect(response.status, await response.clone().text()).toBe(302);

    const consentUrl = new URL(
      z.string().parse(response.headers.get("location")),
      target.configuration.PLATFORM_URL,
    );

    expect(consentUrl.pathname).toBe("/device");

    const consent = await cliConsent(
      consentUrl.searchParams,
      target.configuration,
      target.database.db,
    );

    expect(consent).not.toBeNull();

    return { consentUrl, credential };
  };

  const decide = async (
    target: typeof company,
    consentUrl: URL,
    headers: Headers,
    accept: boolean,
  ) => {
    const response = await target.auth.handler(
      new Request(`${target.configuration.PLATFORM_URL}/api/auth/oauth2/consent`, {
        method: "POST",
        headers: {
          ...Object.fromEntries(headers),
          origin: target.configuration.PLATFORM_URL,
          "content-type": "application/json",
        },
        body: JSON.stringify({ accept, oauth_query: consentUrl.searchParams.toString() }),
      }),
    );

    expect(response.status, await response.clone().text()).toBe(200);
    const callback = new URL(z.object({ url: z.string() }).parse(await response.json()).url);
    expect(callback.origin + callback.pathname).toBe(cliCallbackUrl);

    return callback;
  };

  it.each(["company", "cloud"])(
    "finishes a %s login while the CLI is offline and exchanges only at the selected issuer",
    async (destination) => {
      const target = destination === "cloud" ? cloud : company;
      const started = await begin();

      const url = await cloud.cliLogin.select(
        started.started.request_id,
        started.ticket,
        target.configuration.PLATFORM_URL,
        "employee@example.test",
      );

      const { consentUrl, credential } = await authorization(target, url);
      const callback = await decide(target, consentUrl, credential.headers, true);
      await cloud.cliLogin.complete({
        state: z.string().parse(callback.searchParams.get("state")),
        issuer: z.string().parse(callback.searchParams.get("iss")),
        code: z.string().parse(callback.searchParams.get("code")),
      });
      expect(
        await cloud.cliLogin.complete({
          state: z.string().parse(callback.searchParams.get("state")),
          issuer: z.string().parse(callback.searchParams.get("iss")),
          code: z.string().parse(callback.searchParams.get("code")),
        }),
      ).toBe("authorized");
      const result = await cloud.cliLogin.poll(started.started.request_id, started.pollToken);
      expect(result.status).toBe("authorized");
      expect(result.platform_url).toBe(target.configuration.PLATFORM_URL);
      expect(result).not.toHaveProperty("access_token");
      expect(result).not.toHaveProperty("refresh_token");
      expect(await cloud.cliLogin.poll(started.started.request_id, started.pollToken)).toEqual(
        result,
      );

      const response = await target.auth.handler(
        new Request(`${target.configuration.PLATFORM_URL}/api/auth/oauth2/token`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: "platform-cli",
            grant_type: "authorization_code",
            redirect_uri: cliCallbackUrl,
            code: z.string().parse(result.code),
            code_verifier: started.verifier,
          }),
        }),
      );

      expect(response.status, await response.clone().text()).toBe(200);

      const tokens = z
        .object({ access_token: z.string().min(1), refresh_token: z.string().min(1) })
        .parse(await response.json());

      expect(tokens.access_token).not.toBe(tokens.refresh_token);
    },
  );

  it("recovers the same start response and separates the browser ticket from the polling secret", async () => {
    const value = await begin();
    const repeated = await cloud.cliLogin.start(value.input);
    expect(repeated.verification_uri).toBe(value.started.verification_uri);
    expect(repeated.user_code).toBe(value.started.user_code);
    await expect(cloud.cliLogin.poll(value.started.request_id, value.ticket)).rejects.toThrow(
      "Invalid login request",
    );
    await expect(cloud.cliLogin.inspect(value.started.request_id, value.pollToken)).rejects.toThrow(
      "Invalid login link",
    );
    await expect(
      cloud.cliLogin.start({ ...value.input, poll_hash: "0".repeat(64) }),
    ).rejects.toThrow("already exists");
  });

  it("pins the selected issuer and rejects replayed or cross-issuer callbacks", async () => {
    const value = await begin();

    const url = new URL(
      await cloud.cliLogin.select(
        value.started.request_id,
        value.ticket,
        companyOrigin,
        "employee@example.test",
      ),
    );

    const state = z.string().parse(url.searchParams.get("state"));
    await expect(
      cloud.cliLogin.select(
        value.started.request_id,
        value.ticket,
        cloudOrigin,
        "employee@example.test",
      ),
    ).rejects.toThrow("already has a destination");
    await expect(
      cloud.cliLogin.complete({ state, issuer: `${cloudOrigin}/api/auth`, code: "wrong-issuer" }),
    ).rejects.toThrow("Invalid login callback");
    await cloud.cliLogin.complete({
      state,
      issuer: `${companyOrigin}/api/auth`,
      error: "access_denied",
    });
    expect((await cloud.cliLogin.poll(value.started.request_id, value.pollToken)).status).toBe(
      "denied",
    );
    await expect(
      cloud.cliLogin.complete({ state, issuer: `${companyOrigin}/api/auth`, code: "late-code" }),
    ).rejects.toThrow("Invalid login callback");
  });

  it("returns a provider denial to the waiting CLI without issuing credentials", async () => {
    const value = await begin();

    const url = await cloud.cliLogin.select(
      value.started.request_id,
      value.ticket,
      companyOrigin,
      "employee@example.test",
    );

    const { consentUrl, credential } = await authorization(company, url);
    const callback = await decide(company, consentUrl, credential.headers, false);
    expect(
      await cloud.cliLogin.complete({
        state: z.string().parse(callback.searchParams.get("state")),
        issuer: z.string().parse(callback.searchParams.get("iss")),
        error: z.string().parse(callback.searchParams.get("error")),
      }),
    ).toBe("denied");
    expect(await cloud.cliLogin.poll(value.started.request_id, value.pollToken)).toMatchObject({
      status: "denied",
      code: null,
    });
  });

  it("cannot redeem the intercepted authorization code without the CLI's PKCE key", async () => {
    const value = await begin();

    const url = await cloud.cliLogin.select(
      value.started.request_id,
      value.ticket,
      companyOrigin,
      "employee@example.test",
    );

    const { consentUrl, credential } = await authorization(company, url);
    const callback = await decide(company, consentUrl, credential.headers, true);

    const response = await company.auth.handler(
      new Request(`${companyOrigin}/api/auth/oauth2/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: "platform-cli",
          grant_type: "authorization_code",
          redirect_uri: cliCallbackUrl,
          code: z.string().parse(callback.searchParams.get("code")),
          code_verifier: value.pollToken,
        }),
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).not.toHaveProperty("access_token");
  });

  it("rejects modified consent details and expired login requests", async () => {
    const value = await begin();

    const url = await cloud.cliLogin.select(
      value.started.request_id,
      value.ticket,
      companyOrigin,
      "employee@example.test",
    );

    const { consentUrl } = await authorization(company, url);
    consentUrl.searchParams.set("scope", "openid platform:read network:manage");
    await expect(
      cliConsent(consentUrl.searchParams, company.configuration, company.database.db),
    ).rejects.toThrow("Invalid or expired");
    await cloud.database.db
      .update(verification)
      .set({ expiresAt: new Date(0) })
      .where(eq(verification.id, `cli-login:${value.started.request_id}`));
    await expect(cloud.cliLogin.poll(value.started.request_id, value.pollToken)).rejects.toThrow(
      "expired",
    );
    await expect(cloud.cliLogin.inspect(value.started.request_id, value.ticket)).rejects.toThrow(
      "expired",
    );
  });

  it("binds the working organization to the request, account and current membership", async () => {
    const request = randomBytes(32).toString("base64url");
    const organizationId = crypto.randomUUID();
    const user = company.users.createUser({ email: "context@example.test" });
    await company.users.saveUser(user);
    await company.database.db.insert(organization).values({
      id: organizationId,
      name: "Example Company",
      slug: organizationId,
      createdAt: new Date(),
    });
    await company.database.db.insert(member).values({
      id: crypto.randomUUID(),
      userId: user.id,
      organizationId,
      role: "member",
      createdAt: new Date(),
    });
    await saveCliContext(company.database.db, request, user.id, organizationId);
    await saveCliContext(company.database.db, request, user.id, organizationId);
    expect(await readCliContext(company.database.db, request, user.id, null)).toEqual({
      organization_id: organizationId,
      organization_name: "Example Company",
    });
    await expect(
      saveCliContext(company.database.db, request, user.id, "another-company"),
    ).rejects.toThrow("different account or organization");
    await expect(
      readCliContext(company.database.db, request, company.ownerId, null),
    ).rejects.toThrow("different sign-in");
    await expect(
      readCliContext(company.database.db, request, user.id, "another-company"),
    ).rejects.toThrow("different sign-in");
    await company.database.db.delete(member).where(eq(member.userId, user.id));
    await expect(readCliContext(company.database.db, request, user.id, null)).rejects.toThrow(
      "no longer available",
    );
    await company.database.db
      .update(verification)
      .set({ expiresAt: new Date(0) })
      .where(eq(verification.id, `cli-context:${request}`));
    await expect(readCliContext(company.database.db, request, user.id, null)).rejects.toThrow(
      "missing or expired",
    );
  });

  it("disables the public broker on self-hosted installations", async () => {
    const value = await begin();
    await expect(company.cliLogin.start(value.input)).rejects.toThrow();

    const response = await company.auth.handler(
      new Request(`${companyOrigin}/api/auth/cli-login/start`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: companyOrigin },
        body: JSON.stringify(value.input),
      }),
    );

    expect(response.status).toBe(404);
  });
});
