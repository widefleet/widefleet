import * as contract from "@platform/contracts";
import { Result } from "better-result";
import { and, asc, eq, gt, isNotNull, sql, type AnyColumn } from "drizzle-orm";
import { z } from "zod";
import { storedAppSecrets } from "./app-secrets.ts";
import { ssoProvider } from "./auth-schema.ts";
import type { Database } from "./database.ts";
import { InvalidOperation } from "./errors.ts";
import type { Principal } from "./identity.ts";
import { apps, organizationSettings } from "./schema.ts";
import {
  ciphertextKeyVersion,
  type SecretContext,
  type SecretEncryption,
} from "./secret-encryption.ts";

const pageSize = 100;

/** A row's ciphertexts, and how to replace them if the row still holds them. */
type StoredRow = {
  key: string;
  secrets: { context: SecretContext; ciphertext: string }[];
  /** Writes `next` (old ciphertext to new) only if the row still holds what was read. */
  replace: (next: ReadonlyMap<string, string>) => Promise<boolean>;
};

/**
 * A page of rows. `read` counts the database rows behind it, and `next` is the
 * key to continue after, or `null` once the location has no more rows.
 */
type Page = { rows: StoredRow[]; read: number; next: string | null };

/** Reads the page of rows after `after`, in key order. */
type Location = (database: Database, after: string | null) => Promise<Page>;

// Locations skip rows without ciphertexts, so only the database page itself tells
// whether more rows may follow.
const page = <T>(raw: T[], key: (row: T) => string, rows: StoredRow[]): Page => {
  const last = raw.at(-1);

  return { rows, read: raw.length, next: raw.length === pageSize && last ? key(last) : null };
};

const after = (column: AnyColumn, key: string | null) =>
  key === null ? undefined : gt(column, key);

const replaced = <T>(rows: T[]) => rows.length > 0;

/** Compares a JSON column with the serialized document read earlier. */
const unchanged = (column: AnyColumn, document: string) => sql`${column} = ${document}::jsonb`;

const appSecretValues: Location = async (database, key) => {
  const rows = await database
    .select({ id: apps.id, organizationId: apps.organizationId, secrets: apps.secrets })
    .from(apps)
    .where(and(sql`${apps.secrets} <> '{}'::jsonb`, after(apps.id, key)))
    .orderBy(asc(apps.id))
    .limit(pageSize);

  return page(
    rows,
    (row) => row.id,
    rows.map((row) => {
      const secrets = storedAppSecrets.parse(row.secrets);

      return {
        key: row.id,
        secrets: Object.entries(secrets).map(([name, ciphertext]) => ({
          context: { kind: "app-secret", organizationId: row.organizationId, appId: row.id, name },
          ciphertext,
        })),
        // Leaves the secret revision alone: the values themselves do not change.
        replace: async (next) =>
          replaced(
            await database
              .update(apps)
              .set({
                secrets: Object.fromEntries(
                  Object.entries(secrets).map(([name, value]) => [name, next.get(value) ?? value]),
                ),
              })
              .where(and(eq(apps.id, row.id), unchanged(apps.secrets, JSON.stringify(row.secrets))))
              .returning({ id: apps.id }),
          ),
      };
    }),
  );
};

const organizationSecret =
  (
    column: "directorySecret" | "appClientSecret",
    kind: "directory-client-secret" | "app-login-client-secret",
  ): Location =>
  async (database, key) => {
    const value = organizationSettings[column];

    const rows = await database
      .select({ organizationId: organizationSettings.organizationId, ciphertext: value })
      .from(organizationSettings)
      .where(and(isNotNull(value), after(organizationSettings.organizationId, key)))
      .orderBy(asc(organizationSettings.organizationId))
      .limit(pageSize);

    return page(
      rows,
      (row) => row.organizationId,
      rows.flatMap(({ organizationId, ciphertext }) =>
        ciphertext === null
          ? []
          : [
              {
                key: organizationId,
                secrets: [{ context: { kind, organizationId }, ciphertext }],
                replace: async (next) =>
                  replaced(
                    await database
                      .update(organizationSettings)
                      .set({ [column]: next.get(ciphertext) ?? ciphertext })
                      .where(
                        and(
                          eq(organizationSettings.organizationId, organizationId),
                          eq(value, ciphertext),
                        ),
                      )
                      .returning({ organizationId: organizationSettings.organizationId }),
                  ),
              },
            ],
      ),
    );
  };

const ssoConfiguration =
  (field: "oidcConfig" | "samlConfig"): Location =>
  async (database, key) => {
    const value = ssoProvider[field];

    const rows = await database
      .select({ id: ssoProvider.id, ciphertext: value })
      .from(ssoProvider)
      .where(and(isNotNull(value), after(ssoProvider.id, key)))
      .orderBy(asc(ssoProvider.id))
      .limit(pageSize);

    return page(
      rows,
      (row) => row.id,
      rows.flatMap(({ id, ciphertext }) =>
        ciphertext === null
          ? []
          : [
              {
                key: id,
                secrets: [{ context: { kind: "sso-provider-config", field }, ciphertext }],
                replace: async (next) =>
                  replaced(
                    await database
                      .update(ssoProvider)
                      .set({ [field]: next.get(ciphertext) ?? ciphertext })
                      .where(and(eq(ssoProvider.id, id), eq(value, ciphertext)))
                      .returning({ id: ssoProvider.id }),
                  ),
              },
            ],
      ),
    );
  };

const legacyIdentity = z.looseObject({
  identity: z.looseObject({
    management: z.looseObject({ secret: z.looseObject({ ciphertext: z.string() }) }),
  }),
});

// Startup converts these documents to SSO providers; one can remain if that failed.
const legacyIdentitySecrets: Location = async (database, key) => {
  const rows = await database
    .select({
      organizationId: organizationSettings.organizationId,
      settings: organizationSettings.settings,
    })
    .from(organizationSettings)
    .where(
      and(
        sql`${organizationSettings.settings} ? 'identity'`,
        after(organizationSettings.organizationId, key),
      ),
    )
    .orderBy(asc(organizationSettings.organizationId))
    .limit(pageSize);

  return page(
    rows,
    (row) => row.organizationId,
    rows.flatMap((row) => {
      const parsed = legacyIdentity.safeParse(row.settings);

      if (!parsed.success) return [];
      const settings = parsed.data;
      const ciphertext = settings.identity.management.secret.ciphertext;

      return [
        {
          key: row.organizationId,
          secrets: [
            {
              context: { kind: "legacy-sso-client-secret", organizationId: row.organizationId },
              ciphertext,
            },
          ],
          replace: async (next) =>
            replaced(
              await database
                .update(organizationSettings)
                .set({
                  settings: {
                    ...settings,
                    identity: {
                      ...settings.identity,
                      management: {
                        ...settings.identity.management,
                        secret: {
                          ...settings.identity.management.secret,
                          ciphertext: next.get(ciphertext) ?? ciphertext,
                        },
                      },
                    },
                  },
                })
                .where(
                  and(
                    eq(organizationSettings.organizationId, row.organizationId),
                    unchanged(organizationSettings.settings, JSON.stringify(row.settings)),
                  ),
                )
                .returning({ organizationId: organizationSettings.organizationId }),
            ),
        },
      ];
    }),
  );
};

const locationNames = z.enum([
  "app-secrets",
  "directory-secrets",
  "app-login-secrets",
  "sso-oidc-configs",
  "sso-saml-configs",
  "legacy-identities",
]);

/** Every place that stores ciphertexts of the secret encryption service, in scan order. */
const locations: Record<z.infer<typeof locationNames>, Location> = {
  "app-secrets": appSecretValues,
  "directory-secrets": organizationSecret("directorySecret", "directory-client-secret"),
  "app-login-secrets": organizationSecret("appClientSecret", "app-login-client-secret"),
  "sso-oidc-configs": ssoConfiguration("oidcConfig"),
  "sso-saml-configs": ssoConfiguration("samlConfig"),
  "legacy-identities": legacyIdentitySecrets,
};

const position = z.object({ location: locationNames, after: z.string().nullable() });

type Position = z.infer<typeof position>;

const start: Position = { location: "app-secrets", after: null };

/** Reads one page and returns it with the position after it, or `null` at the end. */
const readPage = async (database: Database, from: Position) => {
  const { rows, read, next } = await locations[from.location](database, from.after);
  const following = locationNames.options[locationNames.options.indexOf(from.location) + 1];

  const resume: Position | null =
    next !== null
      ? { location: from.location, after: next }
      : following
        ? { location: following, after: null }
        : null;

  return { rows, read, resume };
};

/** Opaque to clients, which pass it back to continue. */
const encodeCursor = (value: Position) => Buffer.from(JSON.stringify(value)).toString("base64url");

const decodeCursor = (cursor: string) => {
  try {
    return position.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
  } catch {
    throw new InvalidOperation({
      code: "BAD_REQUEST",
      message: "The re-encryption cursor is invalid",
    });
  }
};

/** Secrets in accepted deployments that are not saved on their app yet. */
export type PendingSecrets = () => Promise<{ deployments: number; ciphertexts: string[] }>;

/**
 * Counts the stored secrets of each key version: the configured versions,
 * active first, then the legacy key and any version the installation lacks.
 * `pending` counts secrets of deployments that will save them later.
 */
export const readSecretEncryption = async (
  database: Database,
  encryption: SecretEncryption,
  pendingSecrets?: PendingSecrets,
) => {
  const counts = new Map<string | null, { values: number; pending: number }>(
    [...encryption.keyVersions, null].map((id) => [id, { values: 0, pending: 0 }]),
  );

  const count = (ciphertext: string, field: "values" | "pending") => {
    const version = ciphertextKeyVersion(ciphertext);
    const current = counts.get(version) ?? { values: 0, pending: 0 };
    counts.set(version, { ...current, [field]: current[field] + 1 });
  };

  for (let from: Position | null = start; from;) {
    const { rows, resume } = await readPage(database, from);

    for (const row of rows) for (const { ciphertext } of row.secrets) count(ciphertext, "values");
    from = resume;
  }

  const pending = (await pendingSecrets?.()) ?? { deployments: 0, ciphertexts: [] };

  for (const ciphertext of pending.ciphertexts) count(ciphertext, "pending");

  return contract.secretEncryptionStatus.parse({
    activeKeyVersion: encryption.activeKeyVersion,
    pendingDeployments: pending.deployments,
    keyVersions: [...counts].map(([id, { values, pending: waiting }]) => ({
      id,
      values,
      pending: waiting,
      active: id === encryption.activeKeyVersion,
      available: id === null || encryption.keyVersions.includes(id),
    })),
  });
};

/**
 * Re-encrypts, with the active key version, the stored secrets of about one
 * page of rows from `cursor` on. Each row is replaced only if it still holds
 * the values read, so concurrent writes win. Callers repeat with the returned
 * cursor until it is `null`; a bounded call keeps each request short.
 */
export const reencryptSecrets = async (
  database: Database,
  encryption: SecretEncryption,
  cursor: string | null = null,
) => {
  let reencrypted = 0;
  let changed = 0;
  let failed = 0;
  let handled = 0;
  let from: Position | null = cursor === null ? start : decodeCursor(cursor);

  while (from && handled < pageSize) {
    const { rows, read, resume } = await readPage(database, from);

    for (const row of rows) {
      const next = new Map<string, string>();

      for (const { context, ciphertext } of row.secrets) {
        if (ciphertextKeyVersion(ciphertext) === encryption.activeKeyVersion) continue;

        try {
          next.set(
            ciphertext,
            await encryption.encrypt(context, await encryption.decrypt(context, ciphertext)),
          );
        } catch {
          failed += 1;
        }
      }

      if (next.size === 0) continue;

      if (await row.replace(next)) reencrypted += next.size;
      else changed += next.size;
    }

    // Rows without ciphertexts cost a read too; an empty location still advances.
    handled += Math.max(read, 1);
    from = resume;
  }

  return contract.secretReencryption.parse({
    reencrypted,
    changed,
    failed,
    cursor: from ? encodeCursor(from) : null,
  });
};

/** Runs every batch, reporting each one, for callers without request limits. */
export const reencryptAllSecrets = async (
  database: Database,
  encryption: SecretEncryption,
  progress: (batch: Awaited<ReturnType<typeof reencryptSecrets>>) => void = () => {},
) => {
  const total = { reencrypted: 0, changed: 0, failed: 0 };

  for (let cursor: string | null = null; ;) {
    const batch = await reencryptSecrets(database, encryption, cursor);
    total.reencrypted += batch.reencrypted;
    total.changed += batch.changed;
    total.failed += batch.failed;
    progress(batch);

    if (batch.cursor === null) return total;
    cursor = batch.cursor;
  }
};

const forbidden = () =>
  Result.err(
    new InvalidOperation({ code: "FORBIDDEN", message: "Administrator permission is required" }),
  );

/**
 * Stored secrets belong to every organization, so only installation
 * administrators read and run re-encryption, through the API, CLI and UI.
 */
export const createSecretMaintenance = (
  database: Database,
  encryption: SecretEncryption,
  pendingSecrets?: PendingSecrets,
) => ({
  status: async (principal: Principal) =>
    principal.admin
      ? Result.ok(await readSecretEncryption(database, encryption, pendingSecrets))
      : forbidden(),
  reencrypt: async (principal: Principal, cursor: string | null) => {
    if (!principal.admin) return forbidden();

    try {
      return Result.ok(await reencryptSecrets(database, encryption, cursor));
    } catch (cause) {
      if (cause instanceof InvalidOperation) return Result.err(cause);
      throw cause;
    }
  },
});
