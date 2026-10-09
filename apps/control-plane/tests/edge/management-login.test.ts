import { chromium } from "@playwright/test";
import { toNodeHandler } from "better-auth/node";
import { once } from "node:events";
import { createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { account, user } from "../../src/lib/server/auth-schema.ts";
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

    it("accepts a signed company identity, persists its Entra object ID and ends the session on logout", async () => {
      const context = await browser.newContext();

      const start = await context.request.post(`${platformUrl}/api/auth/sign-in/social`, {
        headers: { origin: platformUrl },
        data: { provider: "microsoft", callbackURL: "/done", disableRedirect: true },
      });

      expect(start.ok()).toBe(true);
      const authorization = z.object({ url: z.url() }).parse(await start.json());
      const page = await context.newPage();
      await page.goto(authorization.url);
      await page.getByRole("button", { name: /sso@example.test/ }).click();
      await vi.waitFor(() => expect(page.url()).toBe(`${platformUrl}/done`));

      const session = z
        .object({
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
      expect(z.uuid().safeParse(linked?.accountId).success).toBe(true);
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

      const start = await context.request.post(`${platformUrl}/api/auth/sign-in/social`, {
        headers: { origin: platformUrl },
        data: { provider: "microsoft", callbackURL: "/done", disableRedirect: true },
      });

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
