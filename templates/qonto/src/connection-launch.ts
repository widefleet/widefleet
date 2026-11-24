import { z } from "zod";

const storedReturn = z.object({ userId: z.string(), completionUrl: z.url() });

// These tickets share Better Auth's verification storage, not its OAuth state.
// Each is consumed atomically and belongs to the exact issuer/subject user.
// Match Better Auth’s ISO date storage so its expiry cleanup preserves live tickets.
export const connectionLaunch = (database: D1Database, userId: string, origin: string) => {
  const save = async (kind: string, completionUrl: string, duration: number) => {
    const destination = new URL(completionUrl);

    if (
      !["https:", "http:"].includes(destination.protocol) ||
      destination.username ||
      destination.password
    )
      throw new Error("Invalid completion URL");
    const ticket = crypto.randomUUID() + crypto.randomUUID();
    const now = Date.now();
    const expiresAt = now + duration;
    await database
      .prepare(
        "INSERT INTO verification (id, identifier, value, expiresAt, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind(
        crypto.randomUUID(),
        `widefleet:${kind}:${ticket}`,
        JSON.stringify({ userId, completionUrl }),
        new Date(expiresAt).toISOString(),
        new Date(now).toISOString(),
        new Date(now).toISOString(),
      )
      .run();

    return { ticket, expiresAt: new Date(expiresAt).toISOString() };
  };

  const consume = async (kind: string, ticket: string) => {
    const value = await database
      .prepare(
        "DELETE FROM verification WHERE identifier = ? AND expiresAt > ? AND json_extract(value, '$.userId') = ? RETURNING value",
      )
      .bind(`widefleet:${kind}:${ticket}`, new Date().toISOString(), userId)
      .first<string>("value");

    return value ? storedReturn.parse(JSON.parse(value)).completionUrl : null;
  };

  return {
    prepare: async (input: { completionUrl: string }) => {
      const { completionUrl } = z.strictObject({ completionUrl: z.url() }).parse(input);
      // The link may first pass through the app's own company sign-in. Widefleet
      // accepts launch links that expire within five minutes.
      const saved = await save("launch", completionUrl, 240_000);

      return { url: `${origin}/connect/start?ticket=${saved.ticket}`, expiresAt: saved.expiresAt };
    },
    start: async (ticket: string) => {
      const completionUrl = await consume("launch", ticket);

      if (!completionUrl) return null;
      const saved = await save("return", completionUrl, 900_000);

      return `${origin}/connect/complete?ticket=${saved.ticket}`;
    },
    complete: (ticket: string) => consume("return", ticket),
  };
};
