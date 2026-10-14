import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "./database.ts";
import { cloudflareSubscriptionUpdates } from "./schema.ts";
import { CloudflareApiError } from "./cloudflare-provisioning.ts";

const pendingUpdate = z.object({ id: z.uuid(), target: z.json() });

export class CloudflareSubscriptionPending extends Error {
  constructor(scope: string, id: string) {
    super(`Cloudflare subscription update ${id} for ${scope} is unconfirmed`);
    this.name = "CloudflareSubscriptionPending";
  }
}

export const cloudflareSubscriptionRejected = (error: Error) =>
  error instanceof CloudflareApiError &&
  [400, 401, 403, 404, 413, 415, 422, 429].includes(error.status);

// Subscription endpoints have no version annotation. A changed canonical value
// observed after reservation confirms the one outstanding write. Never resend an
// uncertain write or permit a later mutation before this confirmation.
export const updateCloudflareSubscription = async <T extends z.infer<ReturnType<typeof z.json>>>(
  database: Database,
  scope: string,
  subscription: z.ZodType<T>,
  read: () => Promise<T>,
  desired: () => Promise<T>,
  write: (target: T) => Promise<void>,
) => {
  const reservation = await database.transaction(async (transaction) => {
    await transaction.insert(cloudflareSubscriptionUpdates).values({ scope }).onConflictDoNothing();

    const [state] = await transaction
      .select()
      .from(cloudflareSubscriptionUpdates)
      .where(eq(cloudflareSubscriptionUpdates.scope, scope))
      .for("update");

    if (!state) throw new Error("Subscription state not found");
    const current = subscription.parse(await read());
    const pending = state.pending === null ? null : pendingUpdate.parse(state.pending);

    if (pending && JSON.stringify(current) !== JSON.stringify(subscription.parse(pending.target)))
      throw new CloudflareSubscriptionPending(scope, pending.id);
    const target = subscription.parse(await desired());

    if (JSON.stringify(current) === JSON.stringify(target)) {
      if (pending)
        await transaction
          .update(cloudflareSubscriptionUpdates)
          .set({ pending: null })
          .where(eq(cloudflareSubscriptionUpdates.scope, scope));

      return null;
    }

    const id = crypto.randomUUID();
    await transaction
      .update(cloudflareSubscriptionUpdates)
      .set({ pending: { id, target } })
      .where(eq(cloudflareSubscriptionUpdates.scope, scope));

    return { id, target };
  });

  if (!reservation) return;

  const clear = () =>
    database
      .update(cloudflareSubscriptionUpdates)
      .set({ pending: null })
      .where(
        and(
          eq(cloudflareSubscriptionUpdates.scope, scope),
          sql`${cloudflareSubscriptionUpdates.pending}->>'id' = ${reservation.id}`,
        ),
      );

  try {
    await write(reservation.target);
  } catch (error) {
    if (error instanceof Error && cloudflareSubscriptionRejected(error)) {
      await clear();
      throw error;
    }

    throw new CloudflareSubscriptionPending(scope, reservation.id);
  }

  await clear();
};
