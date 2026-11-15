import type { D1Database } from "@cloudflare/workers-types";
import { symmetricEncrypt } from "better-auth/crypto";
import { z } from "zod";

// Persist the pre-managed-OAuth account format from main (3621aeb), without
// invoking the updated template's initialization or authorization code.
export default {
  async fetch(request: Request, environment: { DB: D1Database; AUTH_SECRET: string }) {
    const input = z
      .object({
        provider: z.string(),
        scope: z.string(),
        accessToken: z.string(),
        refreshToken: z.string().optional(),
        expiresAt: z.number().nullable(),
      })
      .parse(await request.json());

    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify(["https://identity.example.test", "alice"])),
    );

    const id = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");

    const encrypt = (data: string) => symmetricEncrypt({ key: environment.AUTH_SECRET, data });
    const now = Date.now();

    await environment.DB.batch([
      environment.DB.prepare(`CREATE TABLE "user" (
        id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
        emailVerified INTEGER NOT NULL, image TEXT, providerEmail TEXT, createdAt DATE NOT NULL, updatedAt DATE NOT NULL
      )`),
      environment.DB.prepare(`CREATE TABLE account (
        id TEXT PRIMARY KEY NOT NULL, accountId TEXT NOT NULL, providerId TEXT NOT NULL,
        userId TEXT NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
        accessToken TEXT, refreshToken TEXT, idToken TEXT,
        accessTokenExpiresAt DATE, refreshTokenExpiresAt DATE, scope TEXT, password TEXT,
        createdAt DATE NOT NULL, updatedAt DATE NOT NULL,
        UNIQUE (userId, providerId), UNIQUE (providerId, accountId)
      )`),
      environment.DB.prepare(`INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt)
        VALUES (?, 'alice', ?, 0, ?, ?)`).bind(id, `${id}@widefleet.invalid`, now, now),
      environment.DB.prepare(`INSERT INTO account
        (id, accountId, providerId, userId, accessToken, refreshToken, accessTokenExpiresAt, scope, createdAt, updatedAt)
        VALUES ('legacy-account', '101', ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
        input.provider,
        id,
        await encrypt(input.accessToken),
        input.refreshToken ? await encrypt(input.refreshToken) : null,
        input.expiresAt,
        input.scope,
        now,
        now,
      ),
    ]);

    return new Response(null, { status: 204 });
  },
};
