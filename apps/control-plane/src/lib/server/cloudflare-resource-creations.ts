import { and, eq } from "drizzle-orm";
import type { Database } from "./database.ts";
import { apps, cloudflareResourceCreations } from "./schema.ts";
import { InvalidOperation } from "./errors.ts";
import { CloudflareApiError, type createCloudflareProvisioner } from "./cloudflare-provisioning.ts";

export type CloudflareResourceKind = "d1" | "r2" | "kv" | "queue";

export type CloudflareResourceCreator = <T>(
  appId: string,
  kind: CloudflareResourceKind,
  name: string,
  read: () => Promise<T | null>,
  create: () => Promise<T>,
) => Promise<T>;

export class CloudflareResourceCreationPending extends Error {
  constructor(scope: string, id: string) {
    super(`Cloudflare resource creation ${id} for ${scope} is unconfirmed`);
    this.name = "CloudflareResourceCreationPending";
  }
}

export const createCloudflareResourceCreator =
  (database: Database, accountId: string): CloudflareResourceCreator =>
  async <T>(
    appId: string,
    kind: CloudflareResourceKind,
    name: string,
    read: () => Promise<T | null>,
    create: () => Promise<T>,
  ) => {
    const scope = `${accountId}/${kind}/${name}`;

    const reservation = await database.transaction(async (transaction) => {
      const [app] = await transaction
        .select({ state: apps.state })
        .from(apps)
        .where(eq(apps.id, appId))
        .for("update");

      if (!app || app.state === "deleting")
        throw new InvalidOperation({
          code: "CONFLICT",
          message: "The app is no longer available for provisioning",
        });

      const [pending] = await transaction
        .select()
        .from(cloudflareResourceCreations)
        .where(eq(cloudflareResourceCreations.scope, scope));

      const current = await read();

      if (current !== null) {
        if (pending)
          await transaction
            .delete(cloudflareResourceCreations)
            .where(eq(cloudflareResourceCreations.scope, scope));

        return { value: current };
      }

      if (pending) throw new CloudflareResourceCreationPending(scope, pending.id);

      const id = crypto.randomUUID();
      // Commit the intent before issuing CREATE. An absent resource cannot prove
      // that a timed-out request has stopped; deletion waits for confirmation.
      await transaction
        .insert(cloudflareResourceCreations)
        .values({ scope, id, appId, kind, name });

      return { id };
    });

    if ("value" in reservation) return reservation.value;

    const clear = () =>
      database
        .delete(cloudflareResourceCreations)
        .where(
          and(
            eq(cloudflareResourceCreations.scope, scope),
            eq(cloudflareResourceCreations.id, reservation.id),
          ),
        );

    try {
      const created = await create();
      await clear();

      return created;
    } catch (error) {
      if (
        error instanceof CloudflareApiError &&
        [400, 401, 403, 404, 413, 415, 422, 429].includes(error.status)
      ) {
        await clear();
        throw error;
      }

      throw new CloudflareResourceCreationPending(scope, reservation.id);
    }
  };

export const settleCloudflareResourceCreations = async (
  database: Database,
  appId: string,
  provisioner: ReturnType<typeof createCloudflareProvisioner>,
) => {
  for (;;) {
    const pending = await database
      .select()
      .from(cloudflareResourceCreations)
      .where(eq(cloudflareResourceCreations.appId, appId))
      .limit(100);

    for (const entry of pending) {
      if (!(await provisioner.findResource(entry.kind, entry.name)))
        throw new CloudflareResourceCreationPending(entry.scope, entry.id);

      await database
        .delete(cloudflareResourceCreations)
        .where(
          and(
            eq(cloudflareResourceCreations.scope, entry.scope),
            eq(cloudflareResourceCreations.id, entry.id),
          ),
        );
    }

    if (pending.length < 100) return;
  }
};
