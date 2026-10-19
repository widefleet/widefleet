import * as contract from "@platform/contracts";
import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { createHash, randomBytes } from "node:crypto";
import type { z } from "zod";
import type { Database } from "./database.ts";
import { InvalidOperation } from "./errors.ts";
import type { Principal } from "./identity.ts";
import { agents } from "./schema.ts";
import { transact } from "./transactions.ts";
import { lockFleet } from "./fleets.ts";

const presentAgent = (record: typeof agents.$inferSelect) =>
  contract.agent.parse({
    id: record.id,
    name: record.name,
    enabled: record.enabled,
    lastSeenAt: record.lastSeenAt?.toISOString() ?? null,
  });

export const createAgentService = (database: Database) => ({
  list: (principal: Principal) =>
    transact(database, async (transaction) => {
      if (!principal.creator)
        return Result.err(
          new InvalidOperation({
            code: "FORBIDDEN",
            message: "App creator permission is required",
          }),
        );

      return Result.ok(
        (
          await transaction
            .select()
            .from(agents)
            .where(eq(agents.fleetId, principal.application.fleetId))
            .orderBy(agents.name)
        ).map(presentAgent),
      );
    }),
  create: (principal: Principal, input: z.infer<typeof contract.createAgentInput>) =>
    transact(database, async (transaction) => {
      if (!principal.admin)
        return Result.err(
          new InvalidOperation({
            code: "FORBIDDEN",
            message: "Administrator permission is required",
          }),
        );

      const fleet = await lockFleet(transaction, principal.application.fleetId);

      if (fleet.executor !== "agent")
        throw new InvalidOperation({
          code: "CONFLICT",
          message: "Cloudflare executes this installation's jobs without an agent",
        });

      const token = `agent_${randomBytes(32).toString("base64url")}`;

      const [record] = await transaction
        .insert(agents)
        .values({
          id: crypto.randomUUID(),
          name: input.name,
          fleetId: fleet.id,
          tokenHash: createHash("sha256").update(token).digest("hex"),
        })
        .returning();

      if (!record) throw new Error("Agent insert returned no row");

      return Result.ok({ agent: presentAgent(record), token });
    }),
  disable: (principal: Principal, agentId: string) =>
    transact(database, async (transaction) => {
      if (!principal.admin)
        return Result.err(
          new InvalidOperation({
            code: "FORBIDDEN",
            message: "Administrator permission is required",
          }),
        );

      const [record] = await transaction
        .update(agents)
        .set({ enabled: false })
        .where(and(eq(agents.id, agentId), eq(agents.fleetId, principal.application.fleetId)))
        .returning();

      if (!record)
        return Result.err(new InvalidOperation({ code: "NOT_FOUND", message: "Agent not found" }));

      return Result.ok(presentAgent(record));
    }),
});
