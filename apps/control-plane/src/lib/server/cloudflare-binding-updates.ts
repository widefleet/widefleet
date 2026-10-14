import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database, DatabaseExecutor } from "./database.ts";
import {
  CloudflareApiError,
  type cloudflareResource,
  type createCloudflareProvisioner,
} from "./cloudflare-provisioning.ts";
import { InvalidOperation } from "./errors.ts";
import { cloudflareRuntimeBindings } from "./schema.ts";

const pendingUpdate = z.object({
  id: z.uuid(),
  bindings: z.array(z.string()),
  createdAt: z.iso.datetime(),
});

export class CloudflareBindingUpdatePending extends Error {
  constructor(scope: string, id: string) {
    super(
      `Cloudflare resource update ${id} for ${scope} is unconfirmed. Further binding changes are blocked until its outcome is verified.`,
    );
    this.name = "CloudflareBindingUpdatePending";
  }
}

export const pendingCloudflareBindingMessage = async (
  database: DatabaseExecutor,
  scope: string,
) => {
  const [record] = await database
    .select()
    .from(cloudflareRuntimeBindings)
    .where(eq(cloudflareRuntimeBindings.scope, scope));

  return record?.pending
    ? new CloudflareBindingUpdatePending(scope, pendingUpdate.parse(record.pending).id).message
    : null;
};

export const updateCloudflareBindings = async (
  database: Database,
  provisioner: ReturnType<typeof createCloudflareProvisioner>,
  resources: z.infer<typeof cloudflareResource>[],
) => {
  if (!resources.length) return;

  const reservation = await database.transaction(async (transaction) => {
    await transaction
      .insert(cloudflareRuntimeBindings)
      .values({ scope: provisioner.scope })
      .onConflictDoNothing();

    const [state] = await transaction
      .select()
      .from(cloudflareRuntimeBindings)
      .where(eq(cloudflareRuntimeBindings.scope, provisioner.scope))
      .for("update");

    if (!state) throw new Error("Runtime binding state not found");

    const current = await provisioner.readBindings();
    const pending = state.pending === null ? null : pendingUpdate.parse(state.pending);
    const confirmed = pending !== null && current.annotations?.["workers/tag"] === pending.id;

    const missing = resources.filter((resource) => {
      const existing = current.bindings.find((binding) => binding.name === resource.name);

      if (!existing) return true;

      const matches =
        existing.type === resource.type &&
        (resource.type === "d1"
          ? (existing.database_id ?? existing.id) === resource.id
          : existing.bucket_name === resource.bucket_name && !existing.jurisdiction);

      if (!matches)
        throw new InvalidOperation({
          code: "CONFLICT",
          message: `Cloudflare binding ${resource.name} points to an unexpected resource`,
        });

      return false;
    });

    if (pending && !confirmed) {
      // Existing apps can still deploy when every binding survives the outstanding write.
      if (
        !missing.length &&
        resources.every((resource) => pending.bindings.includes(resource.name))
      )
        return null;

      throw new CloudflareBindingUpdatePending(provisioner.scope, pending.id);
    }

    if (!missing.length) {
      if (confirmed)
        await transaction
          .update(cloudflareRuntimeBindings)
          .set({ pending: null })
          .where(eq(cloudflareRuntimeBindings.scope, provisioner.scope));

      return null;
    }

    const id = crypto.randomUUID();
    const retained = current.bindings.map((binding) => binding.name);

    // Commit before sending exactly one PATCH. Native retries only read its marker.
    // Never expire this record: a timed-out caller does not cancel the remote write.
    await transaction
      .update(cloudflareRuntimeBindings)
      .set({
        pending: {
          id,
          bindings: [...retained, ...missing.map((binding) => binding.name)],
          createdAt: new Date().toISOString(),
        },
      })
      .where(eq(cloudflareRuntimeBindings.scope, provisioner.scope));

    return { id, retained, missing };
  });

  if (!reservation) return;

  const clear = () =>
    database
      .update(cloudflareRuntimeBindings)
      .set({ pending: null })
      .where(
        and(
          eq(cloudflareRuntimeBindings.scope, provisioner.scope),
          sql`${cloudflareRuntimeBindings.pending}->>'id' = ${reservation.id}`,
        ),
      );

  try {
    await provisioner.writeBindings(reservation.id, reservation.retained, reservation.missing);
  } catch (error) {
    // Explicit validation/auth/rate-limit rejections did not accept the mutation.
    // Timeouts, connection failures, conflicts and server errors remain ambiguous.
    if (
      error instanceof CloudflareApiError &&
      [400, 401, 403, 404, 413, 415, 422, 429].includes(error.status)
    ) {
      await clear();
      throw error;
    }

    throw new CloudflareBindingUpdatePending(provisioner.scope, reservation.id);
  }

  // Another Workflow may already have observed the marker and reserved a newer update.
  await clear();
};
