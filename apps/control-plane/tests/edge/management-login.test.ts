import { chromium } from "@playwright/test";
import { toNodeHandler } from "better-auth/node";
import { once } from "node:events";
import { createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { decodeJwt } from "jose";
import { symmetricDecrypt } from "better-auth/crypto";
import { account, ssoProvider, user } from "../../src/lib/server/auth-schema.ts";
import { createTestEnvironment } from "../environment.ts";

const platformUrl = "http://localhost:25436";

describe.runIf(process.env["RUN_ENTRA_TESTS"] === "1")(
  "Better Auth Microsoft login with emulate",
  () => {
    let environment: Awaited<ReturnType<typeof createTestEnvironment>>;
    let server: ReturnType<typeof createServer>;
    let browser: Awaited<ReturnType<typeof chromium.launch>>;
    let logs = "";

    beforeAll(async () => {
      environment = await createTestEnvironment(platformUrl);
      await environment.database.db.update(ssoProvider).set({ domainVerified: true });
      const auth = environment.auth;

      const handler = toNodeHandler(auth);
      server = createServer((request, response) => {
        if (request.url?.startsWith("/api/auth/")) {
          void handler(request, response).catch((error: Error) => {
            logs += error.message;
            response.writeHead(500).end("Authentication failed");
          });
        } else response.end("Login test callback completed");
      });
      server.listen(25436, "127.0.0.1");
      await once(server, "listening");
      browser = await chromium.launch();
    });

    afterAll(async () => {
      await browser?.close();

      if (server)
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );

      await environment?.close();
    });

    it("accepts a signed company identity, persists its OIDC subject and ends the session on logout", async () => {
      const context = await browser.newContext();
      const issued: string[] = [];
      const network = globalThis.fetch;

      // Saved provider tokens are encrypted; compare them with the token response.
      const tokens = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const response = await network(input, init);

        if (new Request(input, init).url.endsWith("/token") && response.ok)
          issued.push(
            z.object({ access_token: z.string() }).parse(await response.clone().json())
              .access_token,
          );

        return response;
      });

      const start = await context.request.post(`${platformUrl}/api/auth/sign-in/sso`, {
        headers: { origin: platformUrl },
        data: { providerId: "microsoft", callbackURL: "/done" },
      });

      expect(start.ok()).toBe(true);
      const authorization = z.object({ url: z.url() }).parse(await start.json());
      const page = await context.newPage();
      await page.goto(authorization.url);
      await page.getByRole("button", { name: /sso@example.test/ }).click();
      await vi.waitFor(() => expect(page.url()).toBe(`${platformUrl}/done`));
      tokens.mockRestore();

      const session = z
        .object({
          session: z.object({ identityOrganizationId: z.literal("widefleet") }),
          user: z.object({
            id: z.string(),
            email: z.literal("sso@example.test"),
          }),
        })
        .parse(await (await context.request.get(`${platformUrl}/api/auth/get-session`)).json());

      const [saved] = await environment.database.db
        .select()
        .from(user)
        .where(eq(user.id, session.user.id));

      const [linked] = await environment.database.db
        .select()
        .from(account)
        .where(eq(account.userId, session.user.id));

      expect(linked?.providerId).toBe("microsoft");
      expect(linked?.accountId).toBe(decodeJwt(z.string().parse(linked?.idToken))["oid"]);
      const accessToken = z.string().parse(issued.at(-1));
      expect(linked?.accessToken).not.toBe(accessToken);
      expect(
        await symmetricDecrypt({
          key: environment.environment.BETTER_AUTH_SECRET,
          data: z.string().parse(linked?.accessToken),
        }),
      ).toBe(accessToken);
      expect(linked?.userId).toBe(session.user.id);
      expect(saved?.id).toBe(session.user.id);
      const cookies = await context.cookies();
      expect(cookies.find((cookie) => cookie.name === "platform.session_token")).toMatchObject({
        httpOnly: true,
        sameSite: "Lax",
        domain: "localhost",
      });
      expect(
        (
          await context.request.post(`${platformUrl}/api/auth/sign-out`, {
            headers: { origin: platformUrl },
            data: {},
          })
        ).ok(),
      ).toBe(true);
      expect(
        await (await context.request.get(`${platformUrl}/api/auth/get-session`)).json(),
      ).toBeNull();
      await context.close();
    });

    it("rejects a token signed by the same key for a different tenant", async () => {
      const context = await browser.newContext();

      const start = await context.request.post(`${platformUrl}/api/auth/sign-in/sso`, {
        headers: { origin: platformUrl },
        data: { providerId: "microsoft", callbackURL: "/done" },
      });

      expect(start.ok()).toBe(true);
      const authorization = z.object({ url: z.url() }).parse(await start.json());
      const page = await context.newPage();
      await page.goto(authorization.url);
      await page.getByRole("button", { name: /foreign@example.test/ }).click();
      await vi.waitFor(() => expect(page.url()).toContain("error="));
      expect(
        await (await context.request.get(`${platformUrl}/api/auth/get-session`)).json(),
      ).toBeNull();
      expect(
        (await environment.database.db.select().from(user)).map((record) => record.email),
      ).not.toContain("foreign@example.test");
      await context.close();
    });
  },
);
