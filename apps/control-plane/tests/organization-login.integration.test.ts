import { createServer, get } from "node:http";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { once } from "node:events";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { authConfiguration, createAuthProxy } from "@platform/auth-proxy";
import { configurationRevision } from "@platform/auth-proxy/publication";
import { organization, member, invitation, user } from "../src/lib/server/auth-schema.ts";
import {
  installation,
  organizationSettings,
  organizationRuntimes,
} from "../src/lib/server/schema.ts";
import { createSettingsService } from "../src/lib/server/settings.ts";
import { createInstalledAppSignIn } from "../src/lib/server/app-sign-in-installed.ts";
import { createRuntime } from "../src/lib/server/runtime-services.ts";
import type { Runtime } from "../src/lib/server/runtime-services.ts";
import { createStorage } from "../src/lib/server/storage.ts";
import { createApi } from "../src/lib/server/api.ts";
import {
  prepareOrganizationInvitation,
  removeMember,
  changeMemberRole,
} from "../src/lib/server/members.ts";
import type { EmailMessage } from "../src/lib/server/email.ts";
import { createTestEnvironment } from "./environment.ts";

const navigate = (url: string, cookie: string) =>
  new Promise<Response>((resolve, reject) => {
    // Node fetch marks requests as CORS; use navigation headers for the provider's
    // browser redirect, while the proxy exchanges the code through real HTTP.
    get(url, { headers: { cookie, accept: "text/html" } }, (response) => {
      const chunks: Buffer[] = [];
      const headers = new Headers();

      for (const [name, value] of Object.entries(response.headers)) {
        if (Array.isArray(value)) for (const item of value) headers.append(name, item);
        else if (value) headers.set(name, value);
      }

      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () =>
        resolve(
          new Response(Buffer.concat(chunks), {
            status: response.statusCode ?? 500,
            headers,
          }),
        ),
      );
      response.on("error", reject);
    }).on("error", reject);
  });

const cookies = (response: Response) =>
  response.headers
    .getSetCookie()
    .filter((value) => !value.includes("Max-Age=0"))
    .map((value) => value.split(";")[0])
    .join("; ");

describe("Invited organization members with Widefleet OIDC", () => {
  let environment: Awaited<ReturnType<typeof createTestEnvironment>>;
  let runtime: Runtime;
  let resolve: ReturnType<typeof createRuntime>;
  let origin: string;
  const delivered: EmailMessage[] = [];
  const failedRecipients = new Set<string>();
  const published = new Map<string, z.infer<typeof authConfiguration>>();
  const admitted = new Set<string>();
  let available = true;

  const server = createServer((incoming, outgoing) => {
    const handle = async () => {
      if (!available) {
        outgoing.writeHead(503).end();

        return;
      }

      const chunks: Buffer[] = [];

      for await (const chunk of incoming) chunks.push(z.instanceof(Buffer).parse(chunk));
      const headers = new Headers();

      for (const [name, value] of Object.entries(incoming.headers)) {
        if (Array.isArray(value)) for (const item of value) headers.append(name, item);
        else if (value) headers.set(name, value);
      }

      const method = incoming.method ?? "GET";

      const request = new Request(new URL(incoming.url ?? "/", origin), {
        method,
        headers,
        body: method === "GET" ? null : Buffer.concat(chunks),
      });

      const result = request.url.startsWith(`${origin}/api/auth/`)
        ? await runtime.auth.handler(request)
        : await createApi(runtime)(request);

      outgoing.writeHead(result.status, {
        ...Object.fromEntries(result.headers),
        "set-cookie": result.headers.getSetCookie(),
      });
      outgoing.end(Buffer.from(await result.arrayBuffer()));
    };

    void handle().catch(() => outgoing.writeHead(500).end());
  });

  const authRequest = (path: string, body: z.infer<ReturnType<typeof z.json>>, cookie = "") =>
    fetch(`${origin}/api/auth${path}`, {
      method: "POST",
      redirect: "manual",
      headers: { origin, cookie, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    origin = `http://127.0.0.1:${z.object({ port: z.number() }).parse(server.address()).port}`;
    environment = await createTestEnvironment(origin);

    const settings = createSettingsService(
      environment.configuration,
      environment.database.db,
      environment.environment.PLATFORM_ENCRYPTION_KEY,
      (organizationId) =>
        createInstalledAppSignIn(
          environment.configuration,
          Buffer.alloc(32, 3).toString("base64url"),
          async (method, body) => {
            if (method === "PUT")
              published.set(
                organizationId,
                authConfiguration.parse(JSON.parse(z.string().parse(body))),
              );
            const active = published.get(organizationId);

            return Response.json({
              revision: active ? await configurationRevision(active) : "",
              state: active ? "active" : "waiting",
              message: "Synthetic runtime",
            });
          },
          "immediate",
          organizationId,
        ),
      true,
    );

    resolve = createRuntime({
      configuration: environment.configuration,
      database: environment.database,
      settings,
      storage: createStorage(environment.configuration),
      reporting: environment.reporting,
      encryptionKey: environment.environment.PLATFORM_ENCRYPTION_KEY,
      sendEmail: async (message) => {
        if (failedRecipients.has(message.to)) throw new Error("Synthetic delivery failure");
        delivered.push(message);
      },
      organizationAccess: {
        filterOrganizations: async (candidates) =>
          candidates
            .filter((candidate) => admitted.has(candidate.id))
            .map((candidate) => candidate.id),
      },
    });
    runtime = await resolve();
  });
  afterAll(async () => {
    await new Promise<void>((done, reject) =>
      server.close((error) => (error ? reject(error) : done())),
    );
    await environment?.close();
  });

  const credential = (cookie: string) => ({
    auth: runtime.auth,
    headers: new Headers({ cookie, origin }),
  });

  const customer = async (slug: string) => {
    const organizationId = crypto.randomUUID();
    const email = `${slug}@example.test`;

    const prepared = await environment.database.db.transaction(async (transaction) => {
      await transaction
        .insert(organization)
        .values({ id: organizationId, slug, name: slug, createdAt: new Date() });
      await transaction
        .insert(organizationRuntimes)
        .values({ organizationId, appHostnameSuffix: slug });

      return prepareOrganizationInvitation(transaction, organizationId, environment.owner.id, {
        email,
        role: "owner",
      });
    });

    admitted.add(organizationId);
    await runtime.settings.initialize(
      {
        sso: null,
        directory: null,
        externallyManaged: false,
      },
      organizationId,
    );
    runtime = await resolve();
    await runtime.invitations.send(prepared);
    expect(
      (await authRequest("/email-otp/send-verification-otp", { email, type: "sign-in" })).ok,
    ).toBe(true);

    const sent = delivered.findLast(
      (message) => message.to === email && message.subject.includes("sign-in code"),
    );

    const otp = z.string().parse(sent?.text.match(/code is (\d{6})/)?.[1]);
    const authenticated = await authRequest("/sign-in/email-otp", { email, otp, name: slug });
    expect(authenticated.status, await authenticated.clone().text()).toBe(200);

    const user = z
      .object({ user: z.object({ id: z.string() }) })
      .parse(await authenticated.json()).user;

    await runtime.invitations.accept(prepared.invitation.id, credential(cookies(authenticated)));
    const cookie = cookies(authenticated);
    const headers = { cookie, origin, "x-widefleet-organization": organizationId };

    const principal = (
      await runtime.identity.authenticate(
        new Request(`${origin}/api/v1/me`, { headers }),
        "platform:read",
      )
    ).unwrap();

    return { organizationId, email, userId: user.id, cookie, principal };
  };

  const login = async (
    person: Awaited<ReturnType<typeof customer>>,
    controlCookie = person.cookie,
  ) => {
    const configuration = authConfiguration.parse(published.get(person.organizationId));
    const app = `https://notes-${person.email.split("@")[0]}.${configuration.domain}/`;

    const proxy = createAuthProxy(configuration, {
      resolve: async (hostname) =>
        hostname === new URL(app).hostname ? { revision: 0, groups: [] } : null,
      fetch: async () => new Response("App response"),
    });

    const started = await proxy.fetch(
      new Request(
        `https://auth.${configuration.domain}/oauth2/${person.organizationId}/start?rd=${encodeURIComponent(app)}`,
      ),
    );

    expect(started.status).toBe(302);

    const authorized = await navigate(
      z.url().parse(started.headers.get("location")),
      controlCookie,
    );

    expect(authorized.status, await authorized.clone().text()).toBe(302);
    const callback = z.url().parse(authorized.headers.get("location"));

    const completed = await proxy.fetch(
      new Request(callback, { headers: { cookie: cookies(started) } }),
    );

    return { proxy, app, completed };
  };

  it("invites new owners, creates same-named apps and uses the real OAuth provider for isolated app sessions", async () => {
    const alpha = await customer("onboarding-alpha");
    const beta = await customer("onboarding-beta");

    const first = (
      await runtime.apps.create(alpha.principal, {
        slug: "notes",
        displayName: "Notes",
        parentId: null,
      })
    ).unwrap();

    const second = (
      await runtime.apps.create(beta.principal, {
        slug: "notes",
        displayName: "Notes",
        parentId: null,
      })
    ).unwrap();

    expect((await runtime.apps.list(alpha.principal)).unwrap()).toEqual([first]);
    expect((await runtime.apps.list(beta.principal)).unwrap()).toEqual([second]);
    const logged = await login(alpha);
    expect(logged.completed.headers.get("location"), await logged.completed.clone().text()).toBe(
      logged.app,
    );
    const session = cookies(logged.completed);
    available = false;

    try {
      expect(
        (await logged.proxy.fetch(new Request(logged.app, { headers: { cookie: session } })))
          .status,
      ).toBe(200);
    } finally {
      available = true;
    }

    const foreign = await login(beta, alpha.cookie);
    expect(foreign.completed.headers.get("location")).not.toBe(foreign.app);
    await environment.database.db.insert(member).values({
      id: crypto.randomUUID(),
      organizationId: alpha.organizationId,
      userId: environment.owner.id,
      role: "owner",
      createdAt: new Date(),
    });

    const [departing] = await environment.database.db
      .select()
      .from(member)
      .where(and(eq(member.organizationId, alpha.organizationId), eq(member.userId, alpha.userId)));

    expect(
      (
        await removeMember(
          alpha.principal,
          z.string().parse(departing?.id),
          credential(alpha.cookie),
        )
      ).isOk(),
    ).toBe(true);
    const revoked = await login(alpha);
    expect(revoked.completed.headers.get("location")).not.toBe(revoked.app);
  });

  it("uses the native invitation lifetime, duplicate policy and limits", async () => {
    const target = await customer("native-invitations");
    const recipient = await customer("native-recipient");
    const before = Date.now();

    const invited = await runtime.invitations.invite(
      target.principal,
      { email: recipient.email, role: "member" },
      credential(target.cookie),
    );

    expect(new Date(invited.expiresAt).getTime() - before).toBeGreaterThan(47 * 60 * 60 * 1000);
    expect(new Date(invited.expiresAt).getTime() - before).toBeLessThanOrEqual(
      48 * 60 * 60 * 1000 + 1000,
    );
    await expect(
      runtime.invitations.invite(
        target.principal,
        { email: recipient.email, role: "admin" },
        credential(target.cookie),
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    const pending = Array.from({ length: 99 }, (_, index) => ({
      id: crypto.randomUUID(),
      organizationId: target.organizationId,
      inviterId: target.userId,
      email: `pending-${index}@example.test`,
      role: "member",
      status: "pending",
      expiresAt: new Date(Date.now() + 60_000),
    }));

    await environment.database.db.insert(invitation).values(pending);
    await expect(
      runtime.invitations.invite(
        target.principal,
        { email: "over-limit@example.test", role: "member" },
        credential(target.cookie),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const existing = Array.from({ length: 99 }, (_, index) => ({
      id: crypto.randomUUID(),
      name: `Fixture ${index}`,
      email: `large-${index}@example.test`,
      emailVerified: true,
    }));

    await environment.database.db.insert(user).values(existing);
    await environment.database.db.insert(member).values(
      existing.map((subject) => ({
        id: crypto.randomUUID(),
        organizationId: target.organizationId,
        userId: subject.id,
        role: "member",
        createdAt: new Date(),
      })),
    );
    await expect(
      runtime.invitations.accept(invited.id, credential(recipient.cookie)),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("uses the API for invitations, rejects foreign and stale administration, and preserves the last owner", async () => {
    const alpha = await customer("invite-alpha");
    const beta = await customer("invite-beta");
    const api = createApi(runtime);

    const call = (
      person: typeof alpha,
      method: string,
      path: string,
      body?: z.infer<ReturnType<typeof z.json>>,
    ) =>
      api(
        new Request(`${origin}/api/v1${path}`, {
          method,
          headers: {
            cookie: person.cookie,
            origin,
            "x-widefleet-organization": person.organizationId,
            "content-type": "application/json",
          },
          body: body ? JSON.stringify(body) : null,
        }),
      );

    const beforeFailure = delivered.length;
    failedRecipients.add(beta.email);

    const failed = await call(alpha, "POST", "/invitations", {
      email: beta.email,
      role: "admin",
    });

    // Better Auth logs delivery failures and still returns the saved invitation.
    expect(failed.status).toBe(200);
    expect(delivered).toHaveLength(beforeFailure);

    const undelivered = z
      .array(z.object({ id: z.uuid(), email: z.email() }))
      .parse(await (await call(alpha, "GET", "/invitations")).json());

    const failedInvitations = undelivered.filter((entry) => entry.email === beta.email);
    expect(failedInvitations).toHaveLength(1);
    const failedInvitationId = z.string().parse(failedInvitations[0]?.id);
    const previousExpiry = new Date(Date.now() + 60_000);
    await environment.database.db
      .update(invitation)
      .set({ expiresAt: previousExpiry })
      .where(eq(invitation.id, failedInvitationId));
    failedRecipients.delete(beta.email);

    expect(
      (
        await call({ ...beta, organizationId: alpha.organizationId }, "POST", "/invitations", {
          email: beta.email,
          role: "admin",
          resend: true,
        })
      ).status,
    ).toBe(403);
    const beforeDelivery = delivered.length;

    const created = await call(alpha, "POST", "/invitations", {
      email: beta.email.toUpperCase(),
      role: "member",
      resend: true,
    });

    expect(created.status, await created.clone().text()).toBe(200);

    const invited = z
      .object({ id: z.uuid(), role: z.string(), expiresAt: z.iso.datetime() })
      .parse(await created.json());

    expect(invited.id).toBe(failedInvitationId);
    // Resend renews the native invitation; it does not replace its assigned role.
    expect(invited.role).toBe("admin");
    expect(new Date(invited.expiresAt).getTime()).toBeGreaterThan(previousExpiry.getTime());
    expect(delivered).toHaveLength(beforeDelivery + 1);
    expect(delivered.at(-1)?.text).toContain(`/invitations/${failedInvitationId}`);
    expect(await (await call(alpha, "GET", "/invitations")).json()).toHaveLength(
      undelivered.length,
    );
    expect((await call(beta, "DELETE", `/invitations/${invited.id}`)).status).toBe(404);
    expect((await call(alpha, "POST", `/invitations/${invited.id}/accept`, {})).status).toBe(403);
    expect((await call(beta, "GET", `/invitations/${invited.id}`)).status).toBe(200);
    expect(
      (
        await call(beta, "POST", `/invitations/${invited.id}/accept`, {
          name: "Invited administrator",
        })
      ).status,
    ).toBe(200);
    expect((await call(beta, "POST", `/invitations/${invited.id}/accept`, {})).status).toBe(409);

    const [acceptedUser] = await environment.database.db
      .select()
      .from(user)
      .where(eq(user.id, beta.userId));

    expect(acceptedUser?.name).toBe("invite-beta");
    const joined = { ...beta, organizationId: alpha.organizationId };

    const protectedResponse = await call(alpha, "POST", "/invitations", {
      email: "protected-owner@example.test",
      role: "owner",
    });

    expect(protectedResponse.status).toBe(200);
    const protectedInvitation = z.object({ id: z.string() }).parse(await protectedResponse.json());

    for (const role of ["member", "admin"])
      expect(
        (
          await call(joined, "POST", "/invitations", {
            email: "PROTECTED-OWNER@example.test",
            role,
          })
        ).status,
      ).toBe(400);
    expect(
      await environment.database.db
        .select({ id: invitation.id, role: invitation.role, status: invitation.status })
        .from(invitation)
        .where(
          and(
            eq(invitation.organizationId, alpha.organizationId),
            eq(invitation.email, "protected-owner@example.test"),
          ),
        ),
    ).toEqual([{ id: protectedInvitation.id, role: "owner", status: "pending" }]);
    expect(
      (
        await call(joined, "POST", "/invitations", {
          email: "owner-escalation@example.test",
          role: "owner",
        })
      ).status,
    ).toBe(403);
    const listed = await call(alpha, "GET", "/members?page=1");

    const members = z
      .object({ members: z.array(z.object({ id: z.string(), userId: z.string() })) })
      .parse(await listed.json()).members;

    const ownerId = z.string().parse(members.find((entry) => entry.userId === alpha.userId)?.id);
    const adminId = z.string().parse(members.find((entry) => entry.userId === beta.userId)?.id);
    expect((await call(alpha, "DELETE", `/members/${ownerId}`)).status).toBe(409);
    expect((await call(joined, "DELETE", `/members/${ownerId}`)).status).toBe(409);

    const pending = await call(joined, "POST", "/invitations", {
      email: "pending-member@example.test",
      role: "member",
    });

    expect(pending.status).toBe(200);
    const pendingId = z.object({ id: z.string() }).parse(await pending.json()).id;

    const stale = (
      await runtime.identity.authenticate(
        new Request(`${origin}/api/v1/me`, {
          headers: { cookie: beta.cookie, "x-widefleet-organization": alpha.organizationId },
        }),
        "platform:read",
      )
    ).unwrap();

    expect((await call(alpha, "PATCH", `/members/${adminId}`, { role: "member" })).status).toBe(
      200,
    );
    await expect(
      runtime.invitations.invite(
        stale,
        { email: "stale-admin@example.test", role: "member" },
        credential(beta.cookie),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const [revoked] = await environment.database.db
      .select()
      .from(invitation)
      .where(eq(invitation.id, pendingId));

    expect(revoked?.status).toBe("pending");

    const expired = await call(alpha, "POST", "/invitations", {
      email: "expired@example.test",
      role: "member",
    });

    const expiredId = z.object({ id: z.string() }).parse(await expired.json()).id;
    await environment.database.db
      .update(invitation)
      .set({ expiresAt: new Date(0) })
      .where(eq(invitation.id, expiredId));
    const count = delivered.length;
    await authRequest("/email-otp/send-verification-otp", {
      email: "expired@example.test",
      type: "sign-in",
    });
    expect(delivered).toHaveLength(count);
  });

  it("leaves issued invitations valid after inviter demotion", async () => {
    const inviter = await customer("demoted-inviter");
    const other = await customer("remaining-owner");
    const recipient = await customer("demotion-recipient");
    await environment.database.db.insert(member).values({
      id: crypto.randomUUID(),
      organizationId: inviter.organizationId,
      userId: other.userId,
      role: "owner",
      createdAt: new Date(),
    });

    const ownerInvite = await runtime.invitations.invite(
      inviter.principal,
      {
        email: recipient.email,
        role: "owner",
      },
      credential(inviter.cookie),
    );

    const memberInvite = await runtime.invitations.invite(
      inviter.principal,
      {
        email: "retained-member@example.test",
        role: "member",
      },
      credential(inviter.cookie),
    );

    const [membership] = await environment.database.db
      .select()
      .from(member)
      .where(
        and(eq(member.organizationId, inviter.organizationId), eq(member.userId, inviter.userId)),
      );

    expect(
      (
        await changeMemberRole(
          { ...other.principal, application: inviter.principal.application },
          { memberId: z.string().parse(membership?.id), role: "admin" },
          credential(other.cookie),
        )
      ).isOk(),
    ).toBe(true);
    const pending = await runtime.invitations.list({ ...inviter.principal, role: "admin" });
    expect(pending.find((entry) => entry.id === ownerInvite.id)?.status).toBe("pending");
    expect(pending.find((entry) => entry.id === memberInvite.id)?.status).toBe("pending");
    await expect(
      runtime.invitations.accept(ownerInvite.id, credential(recipient.cookie)),
    ).resolves.toEqual({ organizationId: inviter.organizationId });
    expect(
      await environment.database.db
        .select()
        .from(member)
        .where(
          and(
            eq(member.organizationId, inviter.organizationId),
            eq(member.userId, recipient.userId),
          ),
        ),
    ).toEqual([expect.objectContaining({ role: "owner" })]);
  });

  it("does not send codes or create access for arbitrary public registrations", async () => {
    const count = delivered.length;
    expect(
      (
        await authRequest("/email-otp/send-verification-otp", {
          email: "uninvited@example.test",
          type: "sign-in",
        })
      ).status,
    ).toBe(200);
    expect(delivered).toHaveLength(count);
    expect(
      (await authRequest("/sign-in/email-otp", { email: "uninvited@example.test", otp: "123456" }))
        .status,
    ).toBe(401);
  });
  it.runIf(process.env["RUN_CLI_TESTS"] === "1")(
    "manages invitations and roles through the real CLI and shared API",
    async () => {
      const owner = await customer("cli-invitations");

      const recipient = environment.users.createUser({
        email: "cli-recipient@example.test",
        emailVerified: true,
      });

      await environment.users.saveUser(recipient);

      const token = async (userId: string) => {
        const now = Math.floor(Date.now() / 1000);

        return (
          await runtime.auth.api.signJWT({
            body: {
              payload: {
                sub: userId,
                reference_id: `user:${userId}`,
                aud: `${origin}/api/v1`,
                iss: `${origin}/api/auth`,
                iat: now,
                exp: now + 300,
                scope: "platform:read platform:write",
              },
            },
          })
        ).token;
      };

      const ownerToken = await token(owner.userId);
      const recipientToken = await token(recipient.id);

      const binary =
        process.env["CLI_BINARY"] ??
        fileURLToPath(
          new URL(
            `../../../target/debug/${process.platform === "win32" ? "widefleet.exe" : "widefleet"}`,
            import.meta.url,
          ),
        );

      const execute = promisify(execFile);

      const cli = async (accessToken: string, ...args: string[]) => {
        const result = await execute(binary, ["--organization", owner.organizationId, ...args], {
          env: {
            ...process.env,
            PLATFORM_URL: origin,
            PLATFORM_ACCESS_TOKEN: accessToken,
            PLATFORM_USAGE_REPORTING: "false",
            PLATFORM_CRASH_REPORTING: "false",
          },
          timeout: 10000,
        });

        return z.json().parse(JSON.parse(result.stdout));
      };

      const invited = z
        .object({ id: z.string() })
        .parse(await cli(ownerToken, "invitations", "invite", recipient.email));

      const beforeDelivery = delivered.length;
      expect(
        await cli(ownerToken, "invitations", "invite", recipient.email, "--resend"),
      ).toMatchObject({ id: invited.id, role: "member", status: "pending" });
      expect(delivered).toHaveLength(beforeDelivery + 1);

      expect(await cli(ownerToken, "invitations", "list")).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: invited.id, role: "member", status: "pending" }),
        ]),
      );
      expect(await cli(recipientToken, "invitations", "show", invited.id)).toMatchObject({
        organizationId: owner.organizationId,
      });
      expect(await cli(recipientToken, "invitations", "accept", invited.id)).toMatchObject({
        organizationId: owner.organizationId,
      });

      expect(await cli(recipientToken, "account")).toMatchObject({
        organizationId: owner.organizationId,
        provider: null,
        linked: false,
        accountUrl: `${origin}/account`,
      });

      const listing = z
        .object({ members: z.array(z.object({ id: z.string(), email: z.string() })) })
        .parse(await cli(ownerToken, "members", "list"));

      const membership = z
        .string()
        .parse(listing.members.find((entry) => entry.email === recipient.email)?.id);

      expect(await cli(ownerToken, "members", "role", membership, "admin")).toMatchObject({
        changed: true,
      });
      expect(await cli(ownerToken, "members", "remove", membership)).toMatchObject({
        changed: true,
      });
      await expect(cli(recipientToken, "members", "list")).rejects.toThrow();

      const canceled = z
        .object({ id: z.string() })
        .parse(await cli(ownerToken, "invitations", "invite", recipient.email));

      expect(await cli(ownerToken, "invitations", "cancel", canceled.id)).toMatchObject({
        canceled: true,
      });
    },
  );
  it("activates built-in app sign-in through the setup API without company settings", async () => {
    await environment.database.db
      .update(installation)
      .set({ ownerId: null })
      .where(eq(installation.id, "widefleet"));
    await environment.database.db
      .update(organizationSettings)
      .set({
        settings: {
          directory: null,
          externallyManaged: false,
        },
        appClientSecret: null,
      })
      .where(eq(organizationSettings.organizationId, "widefleet"));
    published.delete("widefleet");

    const setup = () =>
      fetch(`${origin}/api/v1/setup`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({
          name: "Email API Owner",
          email: "email-api-owner@example.test",
          password: "synthetic-api-owner-password",
        }),
      });

    const created = await setup();
    expect(created.status).toBe(200);
    expect(published.get("widefleet")?.provider).toMatchObject({
      type: "oidc",
      issuer: `${origin}/api/auth`,
    });
    expect((await runtime.settings.inspect()).activation.state).toBe("active");
    expect((await setup()).status).toBe(409);
  });
});
